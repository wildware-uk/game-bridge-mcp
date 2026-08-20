import type { GameState, SyncResult, CommandAck } from "./client.js";
import type { ArgDef, Manifest } from "./manifest.js";

/**
 * What a composite tool is handed when it runs.
 *
 * Everything is scoped to one instance, so a composite never has to think about
 * ports: it was already resolved before the composite was reached.
 */
export interface CompositeContext {
  port: number;
  args: Record<string, unknown>;
  state(): Promise<GameState>;
  health(): Promise<Record<string, unknown>>;
  /** Queue a command without waiting for it to be applied. */
  command(name: string, args?: Record<string, unknown>): Promise<CommandAck>;
  /** Queue a command and wait until the game reports it applied. */
  commandAndSync(name: string, args?: Record<string, unknown>, timeoutMs?: number): Promise<SyncResult>;
  /** Call any other tool on this instance, composite or game command. */
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
  manifest(): Promise<Manifest>;
  summarise(state: GameState): Record<string, unknown>;
  sleep(ms: number): Promise<void>;
  /** Wait for the port to stop answering. Only `close` should need this. */
  waitForSilence(timeoutMs?: number): Promise<boolean>;
}

/**
 * A tool the bridge runs itself rather than forwarding to the game.
 *
 * The rule for what belongs here: a composite either chains several commands,
 * or waits for something `/command` cannot report. Anything that is one command
 * with one set of arguments belongs in the game's own manifest instead, where
 * it stays in step with the code that implements it.
 *
 * `only` names the games a composite makes sense for, matched against the
 * manifest's `game.name`. A bridge that claims to be generic must not offer
 * `stack_crates` to a game that has no crates.
 */
export interface Composite {
  name: string;
  description: string;
  only?: string | string[];
  args?: ArgDef[];
  run(ctx: CompositeContext): Promise<unknown>;
}

export function compositeApplies(composite: Composite, gameName: string | undefined): boolean {
  if (!composite.only) return true;
  const allowed = Array.isArray(composite.only) ? composite.only : [composite.only];
  return gameName !== undefined && allowed.includes(gameName);
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** Read "game.score" out of a snapshot. Dotted paths keep wait_for declarative. */
function atPath(state: unknown, path: string): unknown {
  let cursor: unknown = state;
  for (const key of path.split(".")) {
    if (cursor === null || typeof cursor !== "object") return undefined;
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function eventStrings(state: GameState): string[] {
  return (state.events ?? [])
    .map((e) => (typeof e === "string" ? e : e?.m))
    .filter((m): m is string => typeof m === "string");
}

/**
 * The composites every conforming game gets, whatever it is.
 *
 * They are deliberately few. Everything here is a property of the HTTP contract
 * rather than of any game - reading state, checking liveness, sending an
 * arbitrary command, shutting down, and waiting for the snapshot to say
 * something - so all five work against a game this package has never heard of.
 */
export const BUILTIN_COMPOSITES: Composite[] = [
  {
    name: "get_state",
    description:
      "The game's full JSON snapshot from GET /state. Pass summary:true for a compact digest " +
      "(frame, screen, scalar game fields, visible UI labels, recent events) instead of the " +
      "whole document, which for a running simulation can be very large.",
    args: [{ name: "summary", type: "boolean", description: "Return a compact digest", default: false }],
    async run(ctx) {
      const s = await ctx.state();
      return ctx.args.summary ? { port: ctx.port, ...ctx.summarise(s) } : s;
    },
  },
  {
    name: "get_health",
    description:
      "Liveness check from GET /health. The cheapest way to confirm an instance is up and its " +
      "frame counter is advancing.",
    args: [],
    async run(ctx) {
      return { port: ctx.port, ...(await ctx.health()) };
    },
  },
  {
    name: "raw_command",
    description:
      "Send any debug command by name with arbitrary arguments, whether or not the game's " +
      "manifest mentions it. The escape hatch that keeps this bridge useful against a game that " +
      "is being written underneath it.",
    args: [
      { name: "cmd", type: "string", description: "Command name, as GET /command expects it", required: true },
      { name: "args", type: "object", description: "Arguments, sent as query parameters" },
      { name: "sync", type: "boolean", description: "Wait for the game to apply it", default: true },
    ],
    async run(ctx) {
      const cmd = String(ctx.args.cmd ?? ctx.args.command ?? "");
      if (!cmd) throw new Error("raw_command needs 'cmd'.");
      const inner = (ctx.args.args ?? {}) as Record<string, unknown>;
      if (ctx.args.sync === false) {
        const ack = await ctx.command(cmd, inner);
        return { port: ctx.port, command: cmd, queued: true, commandId: ack.commandId, frame: ack.frame };
      }
      const result = await ctx.commandAndSync(cmd, inner);
      return {
        port: ctx.port,
        command: cmd,
        applied: true,
        commandId: result.commandId,
        confirmation: result.confirmed ? "completedCommandId" : "frames-advanced",
        ...ctx.summarise(result.state),
      };
    },
  },
  {
    name: "wait_for",
    description:
      "Poll GET /state until a condition holds: a field reaches a value, a field changes, or an " +
      "event appears. This is how you wait for something the command that started it cannot " +
      "report - a queued screenshot reaching disk, a simulation reaching frame N, a score " +
      "settling. Returns whether it matched, how long it took, and the resulting digest.",
    args: [
      { name: "path", type: "string", description: "Dotted path into the snapshot, e.g. 'game.score' or 'simFrame'" },
      { name: "equals", description: "Match when the value at path equals this" },
      { name: "atLeast", type: "number", description: "Match when the numeric value at path reaches this" },
      { name: "changes", type: "boolean", description: "Match when the value at path differs from its first reading" },
      { name: "event", type: "string", description: "Match when a recent event message contains this text" },
      { name: "timeoutMs", type: "integer", description: "Give up after this long", default: 10000 },
      { name: "pollMs", type: "integer", description: "Gap between polls", default: 50 },
    ],
    async run(ctx) {
      const a = ctx.args;
      const path = typeof a.path === "string" ? a.path : undefined;
      const wantEvent = typeof a.event === "string" ? a.event : undefined;
      if (!path && !wantEvent) {
        throw new Error("wait_for needs 'path' (with equals/atLeast/changes) or 'event'.");
      }
      const timeoutMs = num(a.timeoutMs, 10000);
      const pollMs = Math.max(1, num(a.pollMs, 50));
      const deadline = Date.now() + timeoutMs;
      const started = Date.now();

      const first = await ctx.state();
      const initial = path ? atPath(first, path) : undefined;
      let polls = 1;
      let latest = first;
      let matchedOn: string | undefined;

      const matches = (s: GameState): string | undefined => {
        if (wantEvent && eventStrings(s).some((m) => m.includes(wantEvent))) return `event contains '${wantEvent}'`;
        if (!path) return undefined;
        const value = atPath(s, path);
        if (a.equals !== undefined && value === a.equals) return `${path} == ${JSON.stringify(a.equals)}`;
        if (a.atLeast !== undefined && typeof value === "number" && value >= num(a.atLeast, NaN)) {
          return `${path} >= ${a.atLeast}`;
        }
        if (a.changes === true && !Object.is(value, initial)) {
          return `${path} changed from ${JSON.stringify(initial)}`;
        }
        return undefined;
      };

      matchedOn = matches(first);
      while (!matchedOn && Date.now() < deadline) {
        await ctx.sleep(pollMs);
        latest = await ctx.state();
        polls++;
        matchedOn = matches(latest);
      }

      return {
        port: ctx.port,
        matched: matchedOn !== undefined,
        matchedOn,
        elapsedMs: Date.now() - started,
        polls,
        value: path ? atPath(latest, path) : undefined,
        ...ctx.summarise(latest),
      };
    },
  },
  {
    name: "close",
    description:
      "Shut this instance down through the game's own clean-exit path, and wait until the port " +
      "stops answering. This is the correct way to end an instance you started: killing the " +
      "process skips the game's teardown, and on a shared machine you may not know whose " +
      "process you are killing.",
    args: [],
    async run(ctx) {
      // Fire and forget on purpose: the game is on its way out, so waiting for
      // it to report the command completed would always time out. The port
      // going quiet is the confirmation.
      try {
        await ctx.command("close");
      } catch (e) {
        if ((e as Error).name === "GameOffline") return { port: ctx.port, closed: true, note: "was already gone" };
        throw e;
      }
      const gone = await ctx.waitForSilence(10000);
      return gone
        ? { port: ctx.port, closed: true }
        : { port: ctx.port, closed: false, note: "still answering 10s after close" };
    },
  },
];

/**
 * Composites the bridge runs even when the game publishes a command of the same
 * name. Only `close` qualifies: its success condition - the port stops
 * answering - is one no ordinary command path can satisfy, so routing it as a
 * plain command would always end in a timeout.
 */
export const ALWAYS_COMPOSITE = new Set(["close"]);
