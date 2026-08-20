import { readFile } from "node:fs/promises";

import { GameClient, type CommandAck, type FetchLike, type GameState } from "./client.js";
import { resolvePort, type BridgeConfig } from "./config.js";
import { BridgeUsageError, GameOffline, HttpStatusError, NotAGameSurface } from "./errors.js";
import {
  ALWAYS_COMPOSITE,
  BUILTIN_COMPOSITES,
  compositeApplies,
  type Composite,
  type CompositeContext,
} from "./composites.js";
import {
  bridgeToolset,
  fallbackManifest,
  normaliseManifest,
  SUPPORTED_PROTOCOL,
  toInputSchema,
  toolIndex,
  type Manifest,
  type ToolDef,
} from "./manifest.js";
import { pruneEntry, readRegistry, type RegistryEntry, type RegistryIo } from "./registry.js";

export interface BridgeOptions {
  fetchImpl?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
  /** Extra composites, on top of the builtins. This is the extension point a game's own bridge uses. */
  composites?: Composite[];
  /** Filesystem seam for the instance registry, so tests need no real files. */
  registryIo?: RegistryIo;
}

/**
 * One row of `list_instances`.
 *
 * `live-no-manifest` is its own status rather than a footnote on `live`: such a
 * game is fully drivable through /state and /command, it just cannot say what
 * it accepts, and the caller needs to know to work from passthrough.
 */
export interface InstanceReport {
  port: number;
  status: "live" | "live-no-manifest" | "not-a-game" | "free";
  /** Whether this port came from the registry, the port scan, or both. */
  discovery: "registry" | "scan" | "both";
  game?: string;
  version?: string;
  protocol?: number;
  screen?: string;
  frame?: number;
  toolsets?: string[];
  manifest?: Manifest["source"];
  pid?: number;
  cwd?: string;
  started?: string;
  /** Set when a registry entry names a port that no longer answers. */
  stale?: boolean;
  entryFile?: string;
  pruned?: boolean;
  detail?: string;
}

interface CacheEntry {
  manifest: Manifest;
  fetchedAt: number;
}

/**
 * The bridge proper: many game instances, addressed by port, behind one server.
 *
 * Everything here is keyed by port and nothing is bound at construction, which
 * is the entire difference from the single-instance harness this replaces. That
 * one read its port from the environment once at module load, so a team running
 * five instances had one reachable through the tool and four reachable only by
 * hand-writing curl commands.
 */
export class Bridge {
  readonly config: BridgeConfig;
  readonly composites: Composite[];

  private readonly options: BridgeOptions;
  private readonly clients = new Map<number, GameClient>();
  private readonly manifests = new Map<number, CacheEntry>();
  private readonly lastFrame = new Map<number, number>();
  private fileManifest: Manifest | null | undefined;

  constructor(config: BridgeConfig, options: BridgeOptions = {}) {
    this.config = config;
    this.options = options;
    // Later definitions win, so a host application can replace a builtin with
    // something it knows more about.
    const byName = new Map<string, Composite>();
    for (const c of [...BUILTIN_COMPOSITES, ...(options.composites ?? [])]) byName.set(c.name, c);
    this.composites = [...byName.values()];
  }

  port(explicit: unknown): number {
    return resolvePort(explicit, this.config);
  }

  client(port: number): GameClient {
    let client = this.clients.get(port);
    if (!client) {
      client = new GameClient(port, {
        fetchImpl: this.options.fetchImpl,
        sleep: this.options.sleep,
        timeoutMs: this.config.requestTimeoutMs,
        launchHint: this.config.launchHint,
      });
      this.clients.set(port, client);
    }
    return client;
  }

  /**
   * Watch the frame counter for a game that has gone back to the beginning.
   *
   * A restarted game answers on the same port with a fresh frame counter, and
   * its command list may well differ from the one we cached - that is exactly
   * what happens when someone rebuilds a game to add a debug command and runs
   * it again. Frames only ever move forwards within one process, so a frame
   * number that went backwards is a new process and the cache is stale.
   */
  private noteFrame(port: number, frame: unknown): void {
    if (typeof frame !== "number" || !Number.isFinite(frame)) return;
    const previous = this.lastFrame.get(port);
    if (previous !== undefined && frame < previous) this.manifests.delete(port);
    this.lastFrame.set(port, frame);
  }

  private async state(port: number): Promise<GameState> {
    const s = await this.client(port).state();
    this.noteFrame(port, s.frame);
    return s;
  }

  private async loadFileManifest(port: number): Promise<Manifest | null> {
    if (!this.config.manifestPath) return null;
    if (this.fileManifest === undefined) {
      try {
        const text = await readFile(this.config.manifestPath, "utf8");
        this.fileManifest = normaliseManifest(JSON.parse(text), port, "file");
      } catch (e) {
        // A bad --manifest must not take the bridge down; the fallback below
        // still yields a working passthrough, which beats no bridge at all.
        this.fileManifest = null;
        process.stderr.write(`[game-bridge-mcp] could not read manifest file: ${(e as Error).message}\n`);
      }
    }
    return this.fileManifest;
  }

  /** The composites offered for a given game, after `only` filtering. */
  compositesFor(gameName: string | undefined): Composite[] {
    return this.composites.filter((c) => compositeApplies(c, gameName));
  }

  private compositeTools(manifest: Manifest): ToolDef[] {
    return this.compositesFor(manifest.game.name).map((c) => ({
      name: c.name,
      description: c.description,
      arguments: c.args,
      builtin: true,
    }));
  }

  /**
   * The manifest for one instance, cached per port.
   *
   * The cache exists because `list_toolsets`, `describe_toolset` and every
   * `call_tool` would otherwise each cost an extra HTTP round trip to a game
   * that is trying to hold 60fps. It is dropped on an explicit refresh, on a
   * tool-name miss, when the port stops answering, and when the frame counter
   * says the process restarted.
   */
  async manifest(port: number, opts: { refresh?: boolean } = {}): Promise<Manifest> {
    if (opts.refresh) this.manifests.delete(port);
    const cached = this.manifests.get(port);
    if (cached) return cached.manifest;

    let manifest: Manifest;
    try {
      const raw = await this.client(port).getJson<unknown>("/tools");
      manifest = normaliseManifest(raw, port, "game");
    } catch (e) {
      if (e instanceof HttpStatusError || e instanceof NotAGameSurface) {
        // The documented degradation path: a game older than the /tools
        // endpoint is still perfectly drivable through /state and /command, so
        // a 404 here must not be fatal. It only means the game cannot tell us
        // what it accepts, and the caller works from the passthrough.
        const fromFile = await this.loadFileManifest(port);
        manifest = fromFile ?? fallbackManifest(port);
      } else {
        // A dead port is a real failure and must not be cached as a fallback.
        this.manifests.delete(port);
        throw e;
      }
    }

    if (manifest.game.protocol !== undefined && manifest.game.protocol > SUPPORTED_PROTOCOL) {
      manifest = {
        ...manifest,
        passthrough: {
          ...manifest.passthrough,
          description:
            `This game publishes manifest protocol ${manifest.game.protocol}; this bridge understands ` +
            `${SUPPORTED_PROTOCOL}. Tools below were read on a best-effort basis and some may be wrong.\n\n` +
            manifest.passthrough.description,
        },
      };
    }

    this.manifests.set(port, { manifest, fetchedAt: Date.now() });
    return manifest;
  }

  /** Drop cached manifests. Exposed mainly so tests and hosts can assert on caching. */
  invalidate(port?: number): void {
    if (port === undefined) this.manifests.clear();
    else this.manifests.delete(port);
  }

  // ------------------------------------------------------------- discovery

  /**
   * Everything that is running, from the registry and the port scan together.
   *
   * Strictly read-only - GET /health, GET /tools, GET /state and nothing else -
   * because most of what it finds belongs to other people's sessions. A
   * discovery tool that perturbed the instances it found would be worse than no
   * discovery tool.
   */
  async listInstances(
    opts: { ports?: number[]; scan?: boolean; registry?: boolean; prune?: boolean } = {}
  ): Promise<{ instances: InstanceReport[]; registryDir: string; unreadable: string[] }> {
    const useRegistry = opts.registry ?? this.config.useRegistry;
    const useScan = opts.scan ?? this.config.useScan;

    const entries = new Map<number, RegistryEntry>();
    let unreadable: string[] = [];
    if (useRegistry) {
      const read = await readRegistry(this.config.registryDir, this.options.registryIo);
      unreadable = read.unreadable;
      for (const entry of read.entries) entries.set(entry.port, entry);
    }

    const scanPorts = useScan ? (opts.ports ?? this.config.scanPorts) : (opts.ports ?? []);
    const ports = [...new Set([...entries.keys(), ...scanPorts])].sort((a, b) => a - b);

    const instances = await Promise.all(
      ports.map(async (port) => {
        const entry = entries.get(port);
        const inScan = scanPorts.includes(port);
        const discovery: InstanceReport["discovery"] = entry
          ? inScan
            ? "both"
            : "registry"
          : "scan";
        const report = await this.probe(port, discovery);

        if (entry) {
          // Registry data is advisory: it fills in what the live probe cannot
          // know - the pid, the checkout a build came from - but never
          // overrides what the running game said about itself.
          report.pid = entry.pid;
          report.cwd = entry.cwd;
          report.started = entry.started;
          report.entryFile = entry.file;
          report.game = report.game ?? entry.name;
          report.version = report.version ?? entry.version;
          report.protocol = report.protocol ?? entry.protocol;
          if (report.status === "free") {
            // The file outlived its process, which a crash or a force-kill
            // leaves behind routinely. Say so rather than reporting a game
            // that is not there.
            report.stale = true;
            if (opts.prune) report.pruned = await pruneEntry(entry, this.options.registryIo);
          }
        }
        return report;
      })
    );

    return { instances, registryDir: this.config.registryDir, unreadable };
  }

  private async probe(port: number, discovery: InstanceReport["discovery"]): Promise<InstanceReport> {
    // A short timeout on purpose: a scan touches ports that may hold anything,
    // and one unrelated service that accepts connections and never answers
    // must not hang discovery for everyone else.
    const timeout = Math.min(this.config.requestTimeoutMs, 1000);
    let health: { frame?: number };
    try {
      health = await this.client(port).health(timeout);
    } catch (e) {
      if (e instanceof NotAGameSurface) return { port, discovery, status: "not-a-game", detail: e.message };
      return { port, discovery, status: "free" };
    }
    this.noteFrame(port, health.frame);

    const report: InstanceReport = {
      port,
      discovery,
      status: "live",
      frame: typeof health.frame === "number" ? health.frame : undefined,
    };

    try {
      const manifest = await this.manifest(port);
      report.game = manifest.game.name;
      report.version = manifest.game.version;
      report.protocol = manifest.game.protocol;
      report.manifest = manifest.source;
      report.toolsets = [
        ...manifest.toolsets.map((s) => s.name),
        ...(this.compositeTools(manifest).length ? ["bridge"] : []),
      ];
      if (manifest.source !== "game") {
        report.status = "live-no-manifest";
        report.game = manifest.source === "file" ? manifest.game.name : undefined;
      }
    } catch (e) {
      report.status = "live-no-manifest";
      report.detail = (e as Error).message;
    }

    try {
      const s = await this.state(port);
      if (typeof s.ui?.screen === "string") report.screen = s.ui.screen;
      if (typeof s.frame === "number") report.frame = s.frame;
    } catch {
      /* an instance too busy to answer /state is still live */
    }
    return report;
  }

  // ----------------------------------------------------------- meta tools

  /**
   * Every tool callable on one instance, flattened.
   *
   * Only used by `--eager`, for clients that cannot walk a discovery path and
   * need the whole list up front. Composites shadow game commands of the same
   * name, because a composite of that name exists precisely to wait for
   * something the raw command returns too early to report.
   */
  async advertisedTools(port: number): Promise<ToolDef[]> {
    const manifest = await this.manifest(port);
    const composites = this.compositeTools(manifest);
    const seen = new Set(composites.map((t) => t.name));
    const game = manifest.toolsets.flatMap((s) => s.tools).filter((t) => !seen.has(t.name));
    return [...composites, ...game];
  }

  async listToolsets(port: number): Promise<unknown> {
    const manifest = await this.manifest(port);
    const composites = this.compositeTools(manifest);
    return {
      port,
      game: manifest.game,
      manifestSource: manifest.source,
      toolsets: [
        ...manifest.toolsets.map((set) => ({
          name: set.name,
          from: "game",
          description: set.description,
          tools: set.tools.map((t) => t.name),
        })),
        {
          name: "bridge",
          from: "bridge",
          description: bridgeToolset([]).description,
          tools: composites.map((t) => t.name),
        },
      ],
      passthrough: manifest.passthrough.description,
      next: `describe_toolset { port: ${port}, name }, then call_tool { port: ${port}, name, arguments }`,
    };
  }

  async describeToolset(port: number, name: string): Promise<unknown> {
    const manifest = await this.manifest(port);
    if (name === "passthrough") {
      return {
        port,
        ...manifest.passthrough,
        knownCommands: [...toolIndex(manifest).keys()],
        use: "call_tool { name: '<command>', arguments: {...} }",
      };
    }

    const set =
      name === "bridge"
        ? bridgeToolset(this.compositeTools(manifest))
        : manifest.toolsets.find((s) => s.name === name);

    if (!set) {
      return {
        error: `Port ${port} has no toolset '${name}'.`,
        available: [...manifest.toolsets.map((s) => s.name), "bridge", "passthrough"],
      };
    }
    return {
      port,
      name: set.name,
      description: set.description,
      tools: set.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        command: tool.builtin ? undefined : tool.command ?? tool.name,
        from: tool.builtin ? "bridge" : "game",
        inputSchema: toInputSchema(tool),
      })),
    };
  }

  /**
   * Run one tool against one instance.
   *
   * Three layers, in order: composites the bridge runs itself, tools the game
   * published, and finally anything at all as a raw command. The last layer is
   * what keeps this usable against a game being written underneath it - a
   * command added this morning works this afternoon with no release here.
   */
  async callTool(port: number, name: string, args: Record<string, unknown> = {}): Promise<unknown> {
    if (!name) throw new BridgeUsageError("call_tool needs a tool name.");

    // `close` is handled here whatever the manifest says, because its success
    // condition - the port stops answering - is one no ordinary command path
    // can satisfy. Routed as a normal command it would always time out, since
    // the game it is shutting down can never report it completed.
    if (ALWAYS_COMPOSITE.has(name)) {
      const always = this.composites.find((c) => c.name === name);
      if (always) return this.runComposite(port, always, args);
    }

    let manifest = await this.manifest(port);
    const composite = this.compositesFor(manifest.game.name).find((c) => c.name === name);
    if (composite) return this.runComposite(port, composite, args);

    let tool = toolIndex(manifest).get(name);
    if (!tool) {
      // A miss is the signal that our cached manifest is behind the game, so
      // re-fetch once before deciding the tool does not exist. This is what
      // makes a rebuilt game with new commands work without restarting the
      // bridge.
      manifest = await this.manifest(port, { refresh: true });
      tool = toolIndex(manifest).get(name);
    }

    if (tool) {
      return this.runCommand(port, tool.command ?? tool.name, args, tool.sync !== false, {
        tool: tool.name,
        via: "manifest",
      });
    }

    // Not published. Send it anyway - the manifest can lag the game's own
    // `when` block - but if the game rejects it, answer with the list rather
    // than leaving the caller to guess at a typo.
    const result = (await this.runCommand(port, name, args, true, {
      tool: name,
      via: "passthrough",
    })) as Record<string, unknown>;

    const events = (result.events as string[] | undefined) ?? [];
    if (events.some((m) => m.startsWith(`error:unknown_command:${name}`) || m === `error:unknown_command`)) {
      return {
        error: `Port ${port} (${manifest.game.name}) rejected '${name}' as an unknown command.`,
        available: [...toolIndex(manifest).keys()],
        bridge: this.compositesFor(manifest.game.name).map((c) => c.name),
      };
    }
    return result;
  }

  private context(port: number, args: Record<string, unknown>): CompositeContext {
    const client = this.client(port);
    const sleep = this.options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    return {
      port,
      args,
      state: () => this.state(port),
      health: async () => {
        const h = await client.health();
        this.noteFrame(port, h.frame);
        return h;
      },
      command: async (name, inner = {}): Promise<CommandAck> => {
        const ack = await client.command(name, inner);
        this.noteFrame(port, ack.frame);
        return ack;
      },
      commandAndSync: async (name, inner = {}, timeoutMs) => {
        const result = await client.commandAndSync(name, inner, timeoutMs ?? this.config.commandTimeoutMs);
        this.noteFrame(port, result.state.frame);
        return result;
      },
      call: (name, inner = {}) => this.callTool(port, name, inner),
      manifest: () => this.manifest(port),
      summarise,
      sleep,
      waitForSilence: (timeoutMs) => {
        this.manifests.delete(port);
        this.lastFrame.delete(port);
        return client.waitForSilence(timeoutMs);
      },
    };
  }

  private async runComposite(port: number, composite: Composite, args: Record<string, unknown>): Promise<unknown> {
    return composite.run(this.context(port, args));
  }

  private async runCommand(
    port: number,
    command: string,
    args: Record<string, unknown>,
    sync: boolean,
    meta: { tool: string; via: string }
  ): Promise<unknown> {
    const client = this.client(port);
    if (!sync) {
      const ack = await client.command(command, args);
      this.noteFrame(port, ack.frame);
      return { port, ...meta, command, queued: true, commandId: ack.commandId, frame: ack.frame };
    }
    const result = await client.commandAndSync(command, args, this.config.commandTimeoutMs);
    this.noteFrame(port, result.state.frame);
    return {
      port,
      ...meta,
      command,
      applied: true,
      commandId: result.commandId,
      // Games that publish completedCommandId give a real confirmation; the
      // rest only give "frames have advanced", and the caller deserves to know
      // which of the two it just got.
      confirmation: result.confirmed ? "completedCommandId" : "frames-advanced",
      ...summarise(result.state),
    };
  }
}

/**
 * A compact digest of a state snapshot.
 *
 * Generic on purpose - it reports only the fields the HTTP contract defines, so
 * it works for any game. Anything game-specific stays in the full snapshot from
 * `get_state`, which the caller can always ask for.
 */
export function summarise(state: GameState): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof state.frame === "number") out.frame = state.frame;
  if (typeof state.simFrame === "number") out.simFrame = state.simFrame;
  if (typeof state.paused === "boolean") out.paused = state.paused;
  if (state.ui?.screen) out.screen = state.ui.screen;

  const elements = (state.ui?.elements ?? [])
    .filter((e) => e && e.visible !== false && typeof e.label === "string")
    .map((e) => e.label as string);
  if (elements.length) out.elements = elements.slice(0, 60);

  const events = (state.events ?? [])
    .map((e) => (typeof e === "string" ? e : e?.m))
    .filter((m): m is string => typeof m === "string");
  if (events.length) out.events = events.slice(-20);

  // `game` is not part of the contract, but where it exists its scalar fields
  // are the numbers a caller almost always wants; nested objects and arrays are
  // left out because that is where the megabyte-sized entity lists live.
  const game = state.game as Record<string, unknown> | undefined;
  if (game && typeof game === "object") {
    const scalars: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(game)) {
      if (typeof v === "number" || typeof v === "string" || typeof v === "boolean") scalars[k] = v;
    }
    if (Object.keys(scalars).length) out.game = scalars;
  }
  return out;
}
