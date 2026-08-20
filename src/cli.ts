#!/usr/bin/env node
import { parseCli, DEFAULT_PORT, DEFAULT_SCAN_RANGE } from "./config.js";
import { BridgeUsageError } from "./errors.js";
import { applyProjectConfig } from "./launcher.js";
import { startStdioServer, SERVER_VERSION } from "./server.js";

const HELP = `game-bridge-mcp ${SERVER_VERSION}

  A port-addressable MCP bridge for driving running games over a debug HTTP
  surface. It launches instances and picks their ports, finds instances it did
  not launch, and drives any of them - each game's tool list discovered from the
  game itself rather than hardcoded.

Usage
  npx game-bridge-mcp [options]

Options
  -p, --port <n>           Default port for tools that do not name one (default ${DEFAULT_PORT})
      --scan-range <spec>  Ports list_instances sweeps (default ${DEFAULT_SCAN_RANGE})
      --no-scan            Discover only via the instance registry
      --no-registry        Discover only by scanning ports
      --registry-dir <dir> Where instance entries live (default ~/.game-bridge/instances)
      --config <file>      Project launch declaration (default: nearest gamebridge.json)
      --launch-hint <cmd>  Command shown when a port is dead; {port} is substituted
      --manifest <file>    Tool manifest for games that do not serve GET /tools
      --eager              Advertise every tool flatly, for clients that cannot discover
      --timeout <ms>       HTTP and command timeout (default 5000)
  -h, --help
  -v, --version

Environment
  GAME_BRIDGE_PORT, GAME_BRIDGE_SCAN_RANGE, GAME_BRIDGE_LAUNCH_HINT,
  GAME_BRIDGE_MANIFEST, GAME_BRIDGE_CONFIG, GAME_BRIDGE_INSTANCES, GAME_BRIDGE_HOME

A drivable game serves, on 127.0.0.1:<port>:
  GET /health            -> {"ok":true,"frame":N}
  GET /state             -> full JSON snapshot
  GET /command?cmd=NAME  -> {"accepted":true,"commandId":N,"frame":N}
  GET /tools             -> toolset manifest (optional; degrades to passthrough)
...announces itself in ~/.game-bridge/instances/<pid>.json, and declares how it
is started in gamebridge.json.

Register with an MCP client, e.g.
  claude mcp add game-bridge -- npx -y game-bridge-mcp

Full contract and examples: https://github.com/wildware-uk/game-bridge-mcp
`;

async function main(): Promise<void> {
  let parsed;
  try {
    parsed = parseCli(process.argv.slice(2), process.env as Record<string, string | undefined>);
  } catch (e) {
    if (e instanceof BridgeUsageError) {
      process.stderr.write(`${e.message}\n`);
      process.exit(2);
    }
    throw e;
  }

  if (parsed.action === "help") {
    process.stdout.write(HELP);
    return;
  }
  if (parsed.action === "version") {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = parsed.config;

  // The launch declaration is discovered from where the bridge was started,
  // walking upwards, so a project states once how it is run and no caller ever
  // types the command. A missing one is not an error: attaching to a game
  // someone else started is a perfectly good way to use this.
  try {
    await applyProjectConfig(config);
  } catch (e) {
    process.stderr.write(`[game-bridge-mcp] ${(e as Error).message}\n`);
  }

  // Everything logged goes to stderr. stdout is the MCP transport, and a stray
  // line on it corrupts the protocol stream rather than merely being untidy - a
  // failure that presents as the client mysteriously disconnecting.
  process.stderr.write(
    `[game-bridge-mcp] default port ${config.defaultPort}; registry ${config.registryDir}; ` +
      `${config.launch ? `launch configured (${config.projectName ?? "unnamed project"})` : "no launch config found"}\n`
  );

  const { server, bridge, launcher } = await startStdioServer(config);

  /**
   * Reap the children on the way out.
   *
   * The failure this prevents is the one that prompted the launcher: a session
   * ends, or the client disconnects, and the game windows it started stay on
   * the user's desktop with nothing left that knows how to close them.
   */
  let shuttingDown = false;
  const shutdown = async (why: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    const owned = launcher.list();
    if (owned.length) {
      process.stderr.write(`[game-bridge-mcp] ${why}: closing ${owned.length} launched instance(s)\n`);
      await launcher.shutdownAll((port) => bridge.callTool(port, "close", {}).then(() => undefined));
    }
    process.exit(0);
  };

  server.onclose = () => void shutdown("client disconnected");
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.stdin.on("close", () => void shutdown("stdin closed"));
}

main().catch((e) => {
  process.stderr.write(`[game-bridge-mcp] fatal: ${(e as Error).stack ?? String(e)}\n`);
  process.exit(1);
});
