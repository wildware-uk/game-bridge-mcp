# game-bridge-mcp

**Let an AI agent start your game, drive it, and read what happened — over HTTP, one port per instance.**

Your game already knows everything about itself: what is on screen, where every
entity is, what commands it accepts. `game-bridge-mcp` is an
[MCP](https://modelcontextprotocol.io) server that hands that to an agent — as
tools the agent can call, discovered from the running game rather than hardcoded
here.

```
agent ──MCP(stdio)──▶ game-bridge-mcp ──HTTP──▶ 127.0.0.1:7820  ← it launched this one
                                      ├───────▶ 127.0.0.1:7801  ← your IDE started this one
                                      └───────▶ 127.0.0.1:7802  ← a colleague's session
```

Three things make it more than a debug-bridge script you would write in an
afternoon:

- **It launches instances and picks their ports.** No caller ever chooses a
  port or types a build command, so two agents cannot collide, and the bridge
  reaps what it started — no orphaned game windows after a session ends.
- **Every tool takes a `port`.** One bridge drives every instance you have
  running: several agents on one machine, or one agent comparing two builds side
  by side.
- **The tool list comes from the game.** The bridge fetches `GET /tools` from
  each instance at runtime, so a debug command you added this morning is
  callable this afternoon — no release of this package, no reconnect, and no
  drift between what the agent thinks the game accepts and what it accepts.

It is engine-agnostic. Any language, anything that can serve four small HTTP
endpoints on localhost. The [contract](#the-contract) is short on purpose.

---

## Quick start

```bash
npx @wildware/game-bridge-mcp --help
```

Register it with an MCP client — for Claude Code, from your project directory:

```bash
claude mcp add game-bridge -- npx -y @wildware/game-bridge-mcp
```

Then, from the agent's side:

```jsonc
launch_instance {}                                 // start a game; the bridge picks the port
list_instances  {}                                 // ...or find one already running
list_toolsets   { "port": 7820 }                   // what can this instance do?
describe_toolset { "port": 7820, "name": "play" }  // exact schemas
call_tool { "port": 7820, "name": "drop", "arguments": { "x": 1.2 } }
stop_instance { "port": 7820 }                     // clean shutdown, not a kill
```

`launch_instance` needs a [launch declaration](#3-the-launch-declaration).
Everything else works against any game implementing the HTTP surface, whether
this bridge started it or not.

---

## The contract

Implement this and your game is drivable by any agent, through this bridge, with
no code here that knows anything about it. It has three parts, and each one buys
something specific:

| Part | What it buys |
| --- | --- |
| [1. The HTTP surface](#1-the-http-surface) | Reading and driving a running instance. |
| [2. Self-registration](#2-self-registration) | Finding instances without guessing at ports. |
| [3. The launch declaration](#3-the-launch-declaration) | Starting instances without a human choosing a port. |

Only part 1 is required. Part 2 makes discovery reliable; part 3 makes the whole
thing pleasant.

### 1. The HTTP surface

Serve these on `127.0.0.1:<port>`, where the port comes from an explicit
debug flag. Bind to loopback only, and keep the whole surface off unless the
game was launched with that flag: this is a debug surface, not a network
service.

#### `GET /health` — required

The liveness and identity check. Discovery calls it against every port in a
range, so it must be cheap.

```http
GET /health
```
```json
{ "ok": true, "frame": 91422 }
```

`ok: true` is what marks the port as *one of ours*. A port answering HTTP with
anything else is reported to the agent as "something else has taken this port" —
a different problem, with a different fix, from "the game isn't running".

`frame` is a counter that increases for the life of the process. The bridge
watches it: a `frame` that goes *backwards* means a new process is answering on
this port, and the cached tool manifest is dropped automatically. That is what
makes rebuild-and-rerun invisible to the agent.

#### `GET /state` — required

The full snapshot: everything an agent might want to know, as JSON. There is no
required schema — it is your game — but a few conventional fields unlock bridge
features:

```json
{
  "frame": 91422,
  "simFrame": 48110,
  "completedCommandId": 17,
  "paused": false,
  "ui": {
    "screen": "GameScreen",
    "elements": [ { "label": "Restart", "visible": true } ]
  },
  "events": [ { "m": "merge:cherry" }, { "m": "click:Restart" } ],
  "game": { "score": 1280, "state": "RUNNING" }
}
```

| Field | Why the bridge cares |
| --- | --- |
| `frame` | Restart detection; the fallback confirmation that a command ran. |
| `completedCommandId` | The **strong** confirmation that a command ran — see below. |
| `ui.screen` | Reported by `list_instances`, so five instances are tellable apart at a glance. |
| `ui.elements[].label` / `.visible` | Included in the compact `get_state` digest. |
| `events[].m` | Recent events, returned after every command so the agent sees the consequence. Plain strings are accepted too. |
| `game` | Scalar fields are included in the digest. Nested objects and arrays are not — that is where the megabyte-sized entity lists live. |

Everything else you put here is passed through untouched by `get_state`.

#### `GET /command` — required

```http
GET /command?cmd=spawn&type=cherry&x=-1.5
```
```json
{ "accepted": true, "commandId": 18, "frame": 91430 }
```

The command name is keyed **`cmd`**, not `name` — commands routinely take a
`name` argument of their own, and a duplicate query key would silently overwrite
the command being invoked. Every other query parameter is an argument.

**This endpoint is fire-and-forget, and it is the single most important thing to
understand about the contract.** It answers from the HTTP thread the moment the
command is *queued*; the command itself runs later, on the game thread. A client
that reads `/state` immediately afterwards reads the world from *before* the
command happened. The test looks flaky; the game is fine.

The bridge handles this, and the way it does is what your game should support:

1. `GET /command?...` → note the returned `commandId`.
2. Poll `GET /state` until `completedCommandId >= commandId`.
3. Return that state — genuinely after the command ran.

If your game does not publish `completedCommandId`, the bridge degrades to
waiting for `frame` to advance by two and labels the result
`"confirmation": "frames-advanced"`, so the agent knows it got the weaker
guarantee. Publishing `completedCommandId` is a handful of lines and worth it:

```kotlin
// game thread, once per frame
while (true) {
    val cmd = queue.poll() ?: break
    apply(cmd)
    completedCommandId = cmd.id   // published in the next /state snapshot
}
```

A `close` command that shuts the game down through its normal teardown is
strongly recommended: it lets an agent end an instance without killing a process.
The bridge treats `close` specially — it never waits for a completion that cannot
arrive, it waits for the port to go quiet.

#### `GET /tools` — optional, but this is the good part

The manifest: what your game can be told to do, in its own words.

```json
{
  "game": { "name": "Orbital Freight", "version": "0.9.2", "protocol": 1 },
  "toolsets": [
    {
      "name": "play",
      "description": "Drive the game the way a player does.",
      "tools": [
        {
          "name": "drop",
          "description": "Release the held crate, aiming first if x is given.",
          "args": [
            { "name": "x", "type": "number", "description": "World x, -2..2", "required": true, "default": null },
            { "name": "settle", "type": "boolean", "description": "Wait for the stack to settle", "default": "true" }
          ]
        }
      ]
    }
  ],
  "passthrough": {
    "description": "Any command the debug bridge accepts, passed straight through.",
    "examples": ["set_seed { seed }", "set_gravity { x, y }"]
  }
}
```

| Field | Meaning |
| --- | --- |
| `game.name`, `game.version` | Identity. Shown by `list_instances`, which is how an agent tells five running instances apart. |
| `game.protocol` | Versions the **document**, not the command set. Adding a command changes nothing here; restructuring the manifest does. It lets a bridge distinguish "I cannot read this" from "this game knows different commands than last time". Current version: `1`. |
| `toolsets[]` | Groups named for **what a caller is trying to do**, not for how your code is arranged. Keep them few and obvious. |
| `tools[].name` | What the agent calls. |
| `tools[].description` | Written for the agent. Say what it does *and when to reach for it* — this is the text the model reasons over. |
| `tools[].args[]` | `{ name, type, description, required, default }`. `type` is a JSON Schema type name, so one converter serves both game commands and bridge tools. |
| `tools[].command` | The `cmd` to send, if it differs from the tool name. Defaults to the name. |
| `tools[].sync` | `false` for commands that must not be waited on. Defaults to `true`. |
| `tools[].inputSchema` | If you already have JSON Schema, send it instead of `args` and it is used verbatim. |
| `passthrough` | Free text plus examples, describing commands you have not formally published. |

Defaults may be strings (`"true"`, `"0.05"`) — a manifest serialised from a typed
language usually renders them that way. The bridge folds them into the
description rather than emitting `default` in the schema, because
`default: "false"` on a `boolean` property is something a strict client may
reject. `null` means "no default".

The parser is deliberately tolerant, because a manifest gets written in whatever
serialiser was already to hand:

- `toolsets` may be an array of objects **or** a map of `name → toolset`.
- arguments may live under `args`, `arguments` or `params`, as an array of
  objects, an array of bare names, or a map of `name → { type, description }`.
- A malformed tool is dropped, not fatal. One bad entry must not take a whole
  instance offline.

**If `/tools` 404s, nothing breaks.** The bridge falls back to a built-in
manifest containing only the contract-level tools and tells the agent that the
game publishes no command list, so work through `raw_command` and read `/state`.
Instances are reported as `live` or `live-no-manifest` accordingly, and
`--manifest ./my-game.json` supplies one from a file for a game you cannot
change.

### 2. Self-registration

Port scanning is the weak form of discovery: bounded by a range someone guessed
at, silent about a game's identity until it answers, and prone to false
negatives during startup — the exact moment an agent is most likely to look.

So a game that has **successfully bound its debug port** writes one small JSON
file naming itself:

```
~/.game-bridge/instances/<pid>.json
```

```json
{
  "name": "Orbital Freight",
  "version": "0.9.2",
  "protocol": 1,
  "port": 7820,
  "pid": 12345,
  "host": "127.0.0.1",
  "started": "2026-08-20T22:27:19.774Z",
  "cwd": "/home/dev/checkouts/main"
}
```

`cwd` is deliberate: several checkouts of the same game run at once, and "which
build is this?" is otherwise unanswerable from outside the process.

**The rules a writer must follow:**

- Write the entry **after** the port is bound, never before. An entry for a port
  that was never claimed is worse than no entry.
- Delete it on clean shutdown.
- **Never let registry failure break the game.** An unwritable directory, a
  read-only home, a sandbox — the game must still start and still serve its
  endpoints. This is advertising, not infrastructure.
- Honour `GAME_BRIDGE_INSTANCES` (the entries directory) or `GAME_BRIDGE_HOME`
  (its parent) if either is set.

**The rules a reader must follow — and these matter more:**

- **Entries are advisory, never authoritative.** A crash or a force-kill leaves
  the file behind. This happens constantly in practice.
- **Verify every entry** with `GET /health` before believing it. An entry whose
  port does not answer is a stale file, not a running game, and must be reported
  as such rather than as an instance.
- **Never trust an entry over the live game.** The bridge takes name and version
  from `/tools` when the game answers, and uses the entry only for what the wire
  cannot say: pid, working directory, start time.
- **Do not delete other processes' files by default.** A game still binding its
  port is indistinguishable from a crashed one for a second or two. The bridge
  prunes only on an explicit `prune: true`, and only after verifying the port is
  dead.
- **Keep scanning too.** Games predating the registry exist; the bridge merges
  registry entries and a port scan and de-duplicates by port, reporting each
  instance's `discovery` as `registry`, `scan` or `both`.

### 3. The launch declaration

A project declares once how it is started, so no caller ever types a build
command or picks a port. Put `gamebridge.json` in the project root — the bridge
walks up from its working directory to find it, the way every other JS tool
finds its config, and `--config <file>` overrides that.

```json
{
  "name": "Orbital Freight",
  "launch": {
    "command": "./gradlew lwjgl3:run -PdebugPort={port} --console=plain",
    "cwd": ".",
    "portRange": "7820-7839",
    "readyTimeoutMs": 180000,
    "env": { "ORBITAL_DEV": "1" }
  }
}
```

| Field | Meaning |
| --- | --- |
| `command` | Shell command line. `{port}` is substituted. **The port must reach the game from here** — that is the whole mechanism. |
| `argv` | Alternative to `command`: `["./run-game", "--port", "{port}"]`, executed without a shell. |
| `cwd` | Working directory, **resolved relative to this file** — not to wherever the MCP client happened to start the bridge, which is almost never the project. |
| `portRange` | Ports the launcher may claim. Default `7820-7839`, deliberately clear of 7777 and 7800-7810, which are the ports people hand out by hand. |
| `readyTimeoutMs` | How long to wait for `/health`. A cold build plus a JVM is tens of seconds; the default is 180000. |
| `env`, `extraArgs` | Extra environment and trailing arguments. |

What the launcher then guarantees:

- **The port is verified free twice** — nothing bound to it, and nothing
  answering a health check on it — because a game mid-startup has claimed the
  port in the way that matters while still failing a bind test milliseconds
  earlier. If the declared range is full, it falls back to an OS-assigned port.
- **`launch_instance` returns only when `/health` answers**, so a caller never
  writes a retry loop.
- **A boot failure fails loudly, with the child's own output.** When a game
  fails to start, the stack trace is the whole answer:

  ```
  BridgeUsageError: Launch failed on port 7820: the process exited with code 1.
  Command: ./gradlew lwjgl3:run -PdebugPort=7820 --console=plain
  Working directory: /home/dev/orbital
  Full log: /tmp/game-bridge-logs/instance-7820-1787264781573.log

  Last output:
  'gradlew' is not recognized as an internal or external command,
  operable program or batch file.
  ```

- **stdout and stderr are captured** to that log file for the life of the
  instance, and the last 200 lines are held in memory for `instance_log`.
- **Children are reaped.** On `stop_instance`, and on server shutdown, SIGINT,
  SIGTERM or the client disconnecting, every launched instance is closed —
  the game's own `close` command first, then termination of the process tree if
  it will not go. A closed session never leaves game windows on the desktop.

Escalation past a clean close applies **only to processes this bridge spawned
and is still tracking**. `stop_instance` on any other port refuses and tells you
to ask the game to close itself instead.

---

## Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `launch_instance` | `port?`, `timeoutMs?` | Starts a game, picks a free port, waits for `/health`, returns the handle. |
| `list_instances` | `range?`, `registry?`, `scan?`, `prune?` | Registry plus port scan. Names, versions, pids, working directories, screens. Read-only. |
| `stop_instance` | `port?`, `graceMs?` | Clean close, then escalation — only for instances this bridge launched. |
| `instance_log` | `port?`, `lines?` | Captured stdout/stderr of a launched instance. |
| `list_toolsets` | `port?` | That instance's toolsets, as it describes itself. |
| `describe_toolset` | `port?`, `name` | Full JSON Schemas. `bridge` for the bridge's own tools, `passthrough` for unpublished commands. |
| `call_tool` | `port?`, `name`, `arguments?` | Runs a tool, waits for the game to confirm it, returns the resulting digest. |

Only these seven are advertised. The game's own tools are reached through
`call_tool`, because an MCP client is handed the tool list once, when it
connects, and never asks again — a fixed list would be stale for a game still
being written and simply *wrong* when one session is driving two different
builds. (`--eager` flattens everything up front for clients that cannot walk a
discovery path.)

### The bridge's own toolset

Provided for every conforming game, whatever it is:

| Tool | What it does |
| --- | --- |
| `get_state` | The full `/state` snapshot, or `summary: true` for a compact digest. |
| `get_health` | Liveness and frame counter. |
| `raw_command` | Any command by name, published or not. |
| `wait_for` | Poll `/state` until a field reaches a value, a field changes, or an event appears. This is how you wait for what the command that started it cannot report — a queued screenshot reaching disk, a simulation reaching frame N. |
| `close` | Clean shutdown; the port going quiet is the confirmation. |

### How `call_tool` resolves a name

1. **The bridge's composites**, including any a host application registered.
   A composite shadows a game command of the same name, which is always an
   improvement rather than a surprise: a composite carries that name precisely
   because the raw command returns before the thing it asked for has happened.
2. **The game's manifest** — with one re-fetch on a miss, so a rebuilt game with
   new commands is picked up mid-session.
3. **Passthrough** — anything else is sent as a raw command. A command that
   exists in the game but not in its manifest still works today. If the game
   rejects it as unknown, you get the list of what it does accept.

### How `port` resolves

Every tool takes an optional `port` (at the top level or inside `arguments`). It
resolves in this order:

1. the explicit `port` on the call,
2. `--port` on the command line,
3. `GAME_BRIDGE_PORT` in the environment,
4. `7777`.

So a single-instance setup never thinks about ports, and a multi-instance session
never needs a second server.

---

## Driving two instances at once

The scenario this was built for: two builds of the same game, side by side, one
agent, one session.

```jsonc
// 1. What is already running?
list_instances {}
```
```json
{
  "registryDir": "/home/dev/.game-bridge/instances",
  "live": [
    { "port": 7801, "discovery": "scan", "status": "live-no-manifest",
      "frame": 2453, "manifest": "fallback", "screen": "GameScreen" },
    { "port": 7820, "discovery": "both", "status": "live", "game": "Orbital Freight",
      "version": "0.9.2", "protocol": 1, "manifest": "game", "pid": 87488,
      "cwd": "/home/dev/checkouts/main", "screen": "MenuScreen",
      "toolsets": ["play", "build", "flow", "bridge"], "launchedByThisBridge": true }
  ],
  "stale": [],
  "notAGame": [],
  "free": [7777, 7802, 7803]
}
```

Port 7801 is an older build with no `/tools`: still fully drivable, just not
self-describing. Port 7820 is one this bridge started.

```jsonc
// 2. Start a second one. You do not choose the port.
launch_instance {}
```
```json
{ "port": 7821, "pid": 90114, "name": "Orbital Freight", "version": "0.9.3-rc1",
  "cwd": "/home/dev/checkouts/rc", "readyInMs": 4080,
  "logFile": "/tmp/game-bridge-logs/instance-7821-1787264835950.log" }
```

```jsonc
// 3. Same seed, same move, both runs.
call_tool { "port": 7820, "name": "set_seed", "arguments": { "seed": 12345 } }
call_tool { "port": 7821, "name": "set_seed", "arguments": { "seed": 12345 } }

call_tool { "port": 7820, "name": "drop", "arguments": { "x": 1.2 } }
call_tool { "port": 7821, "name": "drop", "arguments": { "x": 1.2 } }
```

Each returns the state *after* the command was applied, so the two are directly
comparable:

```json
{
  "port": 7821, "tool": "drop", "via": "manifest", "command": "drop",
  "applied": true, "commandId": 18, "confirmation": "completedCommandId",
  "frame": 948, "screen": "GameScreen",
  "game": { "score": 1280, "state": "RUNNING" },
  "events": ["merge:cherry", "score:+40"]
}
```

```jsonc
// 4. Wait for something the command could not report.
call_tool { "port": 7821, "name": "wait_for",
            "arguments": { "path": "game.pendingMerges", "equals": 0, "timeoutMs": 5000 } }

// 5. Clean up what you started. 7801 is not yours - leave it alone.
stop_instance { "port": 7821 }
```
```json
{ "port": 7821, "stopped": true, "how": "closed cleanly" }
```

### When something is wrong

The bridge distinguishes the failures that look identical from the outside:

```
GameOffline: No game is answering on http://127.0.0.1:7809.
Start one with:
  ./gradlew lwjgl3:run -PdebugPort=7809

NotAGameSurface: Something is listening on http://127.0.0.1:7802, but it is not a
debuggable game: GET /health returned HTTP 404.
A drivable game must answer GET /health with {"ok":true,"frame":N}. Check whether
another process has taken this port.

CommandTimeout: Command 'restart' was queued on port 7801 but was not applied
within 5000ms. The game accepted it, so it is probably blocked, frozen, or on a
screen that ignores this command.
```

Set the command named in the first message with
`--launch-hint "make run PORT={port}"` (or let `launch_instance` do the starting).

---

## CLI

```
npx @wildware/game-bridge-mcp [options]

  -p, --port <n>           Default port for tools that do not name one (default 7777)
      --scan-range <spec>  Ports list_instances sweeps (default 7777,7800-7810)
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
```

Environment: `GAME_BRIDGE_PORT`, `GAME_BRIDGE_SCAN_RANGE` (or `GAME_BRIDGE_SCAN`),
`GAME_BRIDGE_LAUNCH_HINT` (or `GAME_BRIDGE_LAUNCH`), `GAME_BRIDGE_MANIFEST`,
`GAME_BRIDGE_CONFIG`, `GAME_BRIDGE_INSTANCES`, `GAME_BRIDGE_HOME`.

Everything the bridge logs goes to stderr; stdout is the MCP transport, and a
stray line on it corrupts the protocol stream.

---

## Using it from your own project

The pieces are exported as well as shipped as a CLI. If your game needs tools
that chain several commands — "drop, then wait for the board to settle, then
report the score delta" — register them as **composites** and inherit the
protocol, the launcher, discovery and the error messages rather than maintaining
a second copy of them.

```js
#!/usr/bin/env node
import { parseCli, applyProjectConfig, startStdioServer } from "@wildware/game-bridge-mcp";

const { config } = parseCli(process.argv.slice(2), process.env);
await applyProjectConfig(config);

await startStdioServer(config, {
  composites: [
    {
      name: "drop_and_settle",
      description: "Drop at world x and wait until nothing is moving. The main way to play.",
      only: "Orbital Freight",            // never offered to a game that has no crates
      args: [{ name: "x", type: "number", required: true, description: "World x" }],
      async run(ctx) {
        const before = await ctx.state();
        await ctx.commandAndSync("drop", { x: ctx.args.x });
        const settled = await ctx.call("wait_for", { path: "game.moving", equals: 0, timeoutMs: 10000 });
        const after = await ctx.state();
        return { settled: settled.matched, scoreDelta: after.game.score - before.game.score };
      },
    },
  ],
});
```

A composite is handed a context scoped to one instance — `state`, `health`,
`command`, `commandAndSync`, `call` (any other tool), `manifest`, `summarise`,
`sleep` — so it never has to think about ports. `only` names the games it suits,
matched against the manifest's `game.name`; a bridge that claims to be generic
must not offer `drop_and_settle` to a flight simulator.

The rule for what belongs in a composite: it either **chains several commands**
or **waits for something `/command` cannot report**. Anything that is one command
with one set of arguments belongs in the game's own manifest, where it stays in
step with the code that implements it.

Lower-level pieces — `Bridge`, `GameClient`, `Launcher`, `readRegistry`,
`normaliseManifest` — are exported too. `Bridge` and `GameClient` take an
optional `fetchImpl`, which is how the test suite drives the whole thing without
a game or a socket.

---

## Development

```bash
npm install
npm run build     # TypeScript -> dist/
npm test          # builds, then runs node --test
```

81 tests, none of which need a running game: port resolution order, manifest
caching and its three invalidation paths, the `/tools` 404 fallback, the
command/poll/confirm cycle and its frames-advanced degradation, registry reading
with stale and malformed entries, launcher port selection, boot failure and
child reaping, and the MCP surface itself driven over an in-memory transport.

### Publishing

Not published to npm yet. When it is:

```bash
npm version minor          # keep SERVER_VERSION in src/server.ts in step
npm test                   # prepublishOnly runs build + test again
npm pack --dry-run         # confirm dist/, README.md and LICENSE are the payload
npm publish                # publishConfig.access is already "public"
```

`files` in `package.json` limits the tarball to `dist/`, `README.md` and
`LICENSE`; `prepare` builds on install from git, so a `git`-installed dependency
works without a checked-in `dist/`.

## Licence

MIT — see [LICENSE](LICENSE).
