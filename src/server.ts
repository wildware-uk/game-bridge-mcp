import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { Bridge, type BridgeOptions } from "./bridge.js";
import { parsePortRange, type BridgeConfig } from "./config.js";
import { BridgeUsageError } from "./errors.js";
import { Launcher, type LauncherOptions } from "./launcher.js";
import { toInputSchema, type JsonSchema, type ToolDef } from "./manifest.js";

export const SERVER_NAME = "game-bridge";
export const SERVER_VERSION = "0.1.0";

/**
 * The port argument, spelled the same way on every tool.
 *
 * It is optional everywhere so a single-instance session never has to think
 * about it, and accepted everywhere so a multi-instance session never has to
 * reach for curl.
 */
const portArg = {
  type: "number",
  description:
    "Debug port of the game instance to talk to. Defaults to the bridge's --port, then " +
    "GAME_BRIDGE_PORT, then 7777. launch_instance returns one; list_instances finds the rest.",
};

function withPort(schema: JsonSchema): JsonSchema {
  return { ...schema, properties: { port: portArg, ...(schema.properties ?? {}) } };
}

/**
 * Seven stable tools, and every game's own tools reached through them.
 *
 * An MCP client is handed the tool list once, when it connects, and never asks
 * again. That is fine for a server whose tools are fixed, and wrong for this
 * one: the tools here belong to games that are being written, and they differ
 * between the instances a single session is driving. A fixed list would be
 * stale for one instance and wrong for another. Discovering through these means
 * a command added to a game five minutes ago is callable now, with no reconnect
 * and no release of this package.
 *
 * Lifecycle is the exception and is advertised flatly, because it has to be
 * usable before any game is running - there is nothing to discover from yet.
 */
export const META_TOOLS = [
  {
    name: "launch_instance",
    description:
      "Start a game instance and wait until it answers. The bridge picks a free port itself, so " +
      "you never choose one and never collide with someone else's instance, and it owns the " +
      "process: it is reaped when this server shuts down. Uses the project's launch declaration " +
      "(gamebridge.json). Returns the port to pass to every other tool. Prefer this over " +
      "starting the game yourself.",
    inputSchema: {
      type: "object",
      properties: {
        port: {
          type: "number",
          description: "Force a specific port instead of letting the bridge choose. Rarely needed.",
        },
        timeoutMs: {
          type: "number",
          description: "How long to wait for the game to answer. A cold build plus a JVM can take minutes.",
        },
      },
    },
  },
  {
    name: "list_instances",
    description:
      "What is running: instances that self-registered, plus a sweep of the configured port range " +
      "for games that predate the registry. Reports name, version, pid, working directory, current " +
      "screen and whether each was found via the registry or the scan. Read-only, so it is safe to " +
      "point at instances someone else owns. Use it to attach to a game you did not launch.",
    inputSchema: {
      type: "object",
      properties: {
        range: { type: "string", description: "Ports to sweep, e.g. '7777,7800-7810'. Defaults to --scan-range." },
        registry: { type: "boolean", description: "Read the instance registry (default true)" },
        scan: { type: "boolean", description: "Sweep the port range (default true)" },
        prune: {
          type: "boolean",
          description:
            "Delete registry entries whose port has been verified dead. Off by default: a game still " +
            "binding its port looks identical to a crashed one.",
        },
      },
    },
  },
  {
    name: "stop_instance",
    description:
      "Shut down an instance this bridge launched: the game's own close command first, then " +
      "termination of the process tree if it will not go. Only ever applies to a process this " +
      "bridge started. To ask a game you did not launch to exit, use call_tool { name: 'close' }.",
    inputSchema: {
      type: "object",
      properties: { port: portArg, graceMs: { type: "number", description: "How long to wait for a clean exit" } },
    },
  },
  {
    name: "instance_log",
    description:
      "The captured stdout/stderr of an instance this bridge launched. When a game fails to boot, " +
      "or dies mid-session, the stack trace is here and nowhere else.",
    inputSchema: {
      type: "object",
      properties: { port: portArg, lines: { type: "number", description: "How many trailing lines (default 50)" } },
    },
  },
  {
    name: "list_toolsets",
    description:
      "List the toolsets one instance publishes, as that instance describes itself. Different ports " +
      "can legitimately return different lists. Start here, then describe_toolset, then call_tool.",
    inputSchema: { type: "object", properties: { port: portArg } },
  },
  {
    name: "describe_toolset",
    description:
      "Full schemas for the tools in one toolset on one instance. 'bridge' is the toolset this " +
      "bridge adds itself; 'passthrough' explains how to send commands the game has not published.",
    inputSchema: {
      type: "object",
      properties: { port: portArg, name: { type: "string", description: "Toolset name, 'bridge', or 'passthrough'" } },
      required: ["name"],
    },
  },
  {
    name: "call_tool",
    description:
      "Run a tool on one instance and return the result. Accepts any tool from any of that " +
      "instance's toolsets, and any raw debug command it understands even if unpublished. Commands " +
      "are waited on until the game reports them applied, so the state returned is the state after " +
      "the command ran.",
    inputSchema: {
      type: "object",
      properties: {
        port: portArg,
        name: { type: "string", description: "Tool or command name" },
        arguments: { type: "object", description: "Arguments for the tool" },
      },
      required: ["name"],
    },
  },
];

function text(value: unknown) {
  return {
    content: [
      { type: "text" as const, text: typeof value === "string" ? value : JSON.stringify(value, null, 2) },
    ],
  };
}

export interface ServerOptions extends BridgeOptions {
  launcher?: LauncherOptions;
}

export function createServer(config: BridgeConfig, options: ServerOptions = {}) {
  const bridge = new Bridge(config, options);
  const launcher = new Launcher({
    // The launcher must not carry its own idea of what a live game looks like;
    // it asks the bridge, so "is this port free" and "is the game up" are the
    // same check the rest of the tool uses.
    health: async (port, timeoutMs) => {
      try {
        await bridge.client(port).health(timeoutMs);
        return true;
      } catch {
        return false;
      }
    },
    ...options.launcher,
  });

  const server = new Server(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (!config.eager) return { tools: META_TOOLS };
    try {
      const flat = (await bridge.advertisedTools(config.defaultPort)).map((tool: ToolDef) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: withPort(toInputSchema(tool)),
      }));
      return { tools: [...META_TOOLS, ...flat] };
    } catch {
      // Nothing running yet: the meta tools still work, and list_instances
      // explains why the rest is missing.
      return { tools: META_TOOLS };
    }
  });

  /** Arguments minus `port`, which is addressing rather than an argument. */
  function inner(args: Record<string, unknown>): Record<string, unknown> {
    const copy = { ...((args.arguments ?? {}) as Record<string, unknown>) };
    delete copy.port;
    return copy;
  }

  /** Accept the port at the top level or inside `arguments`; clients write both. */
  function portOf(args: Record<string, unknown>): number {
    const nested = (args.arguments ?? {}) as Record<string, unknown>;
    return bridge.port(args.port ?? nested.port);
  }

  async function dispatch(name: string, args: Record<string, unknown>): Promise<unknown> {
    switch (name) {
      case "launch_instance": {
        if (!config.launch) {
          throw new BridgeUsageError(
            "No launch declaration found. Create gamebridge.json in the project root:\n" +
              '  { "name": "My Game", "launch": { "command": "./run-game --debug-port={port}", "cwd": "." } }\n' +
              "or point at one with --config <file>."
          );
        }
        const spec = args.timeoutMs
          ? { ...config.launch, readyTimeoutMs: Number(args.timeoutMs) }
          : config.launch;
        // Registered instances are excluded so a launch never claims a port a
        // game is still in the middle of binding.
        const known = await bridge
          .listInstances({ scan: false })
          .then((r) => r.instances.map((i) => i.port))
          .catch(() => []);
        const instance = await launcher.launch(spec, {
          port: args.port === undefined ? undefined : bridge.port(args.port),
          exclude: known,
          name: config.projectName,
        });
        let identity: { name?: string; version?: string } = {};
        try {
          const manifest = await bridge.manifest(instance.port);
          identity = { name: manifest.game.name, version: manifest.game.version };
        } catch {
          /* a game with no /tools is still launched and usable */
        }
        return {
          port: instance.port,
          pid: instance.pid,
          ...identity,
          cwd: instance.cwd,
          command: instance.command,
          logFile: instance.logFile,
          readyInMs: Date.now() - instance.startedAt,
          note: "This bridge owns this process and will close it when the session ends. Stop it with stop_instance.",
        };
      }

      case "list_instances": {
        const ports = typeof args.range === "string" ? parsePortRange(args.range) : undefined;
        const { instances, registryDir, unreadable } = await bridge.listInstances({
          ports,
          registry: args.registry === undefined ? undefined : args.registry === true,
          scan: args.scan === undefined ? undefined : args.scan === true,
          prune: args.prune === true,
        });
        const live = instances.filter((i) => i.status === "live" || i.status === "live-no-manifest");
        const launched = new Set(launcher.list().map((i) => i.port));
        return {
          registryDir,
          live: live.map((i) => ({ ...i, launchedByThisBridge: launched.has(i.port) || undefined })),
          stale: instances.filter((i) => i.stale),
          notAGame: instances.filter((i) => i.status === "not-a-game"),
          // Dead ports are the majority of any scan and listing them in full
          // buries the two lines the caller actually wanted.
          free: instances.filter((i) => i.status === "free" && !i.stale).map((i) => i.port),
          unreadableEntries: unreadable.length ? unreadable : undefined,
          note: live.length
            ? "Instances belong to whoever started them. Drive the port you were given; close others' instances only if asked."
            : "Nothing running. launch_instance starts one and picks its port for you.",
        };
      }

      case "stop_instance": {
        const port = portOf(args);
        return launcher.stop(port, {
          grace: args.graceMs === undefined ? undefined : Number(args.graceMs),
          closeCommand: () => bridge.callTool(port, "close", {}).then(() => undefined),
        });
      }

      case "instance_log": {
        const port = portOf(args);
        const instance = launcher.launched(port);
        if (!instance) {
          throw new BridgeUsageError(
            `This bridge did not launch anything on port ${port}, so it has no log for it. ` +
              `Only instances started with launch_instance have captured output.`
          );
        }
        const lines = Math.max(1, Number(args.lines ?? 50));
        return {
          port,
          logFile: instance.logFile,
          exited: instance.exited,
          lines: instance.tail.slice(-lines),
        };
      }

      case "list_toolsets":
        return bridge.listToolsets(portOf(args));

      case "describe_toolset":
        return bridge.describeToolset(portOf(args), String(args.name ?? ""));

      case "call_tool":
        return bridge.callTool(portOf(args), String(args.name ?? ""), inner(args));

      default: {
        // Eager mode, or a client that remembered a tool name from a previous
        // session: the port rides along in the arguments.
        const flatArgs = { ...args };
        delete flatArgs.port;
        return bridge.callTool(bridge.port(args.port), name, flatArgs);
      }
    }
  }

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    try {
      return text(await dispatch(req.params.name, args));
    } catch (e) {
      const err = e as Error;
      return { isError: true, content: [{ type: "text" as const, text: `${err.name}: ${err.message}` }] };
    }
  });

  return { server, bridge, launcher };
}

export async function startStdioServer(config: BridgeConfig, options: ServerOptions = {}) {
  const { server, bridge, launcher } = createServer(config, options);
  await server.connect(new StdioServerTransport());
  return { server, bridge, launcher };
}
