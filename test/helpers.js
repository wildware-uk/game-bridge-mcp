/**
 * A fake game, good enough to exercise the whole bridge without a game.
 *
 * The suite must run in CI and on a laptop with nothing else open, so nothing
 * here opens a socket: the bridge takes its fetch as an option precisely so the
 * HTTP layer can be replaced with this.
 */
export class FakeGame {
  constructor(options = {}) {
    this.name = options.name ?? "Fake Game";
    this.version = options.version ?? "1.0.0";
    this.screen = options.screen ?? "MenuScreen";
    this.frame = options.frame ?? 100;
    this.tools = options.tools ?? null; // null means GET /tools returns 404
    this.reportsCompletedCommandId = options.reportsCompletedCommandId !== false;
    /** How many /state polls a queued command takes to be applied. */
    this.applyAfterPolls = options.applyAfterPolls ?? 1;
    /** Frames added per /state poll, so frame-advance fallbacks can be driven. */
    this.framesPerPoll = options.framesPerPoll ?? 1;
    this.healthStatus = options.healthStatus ?? 200;

    this.nextCommandId = 1;
    this.completedCommandId = 0;
    this.pending = [];
    this.commands = [];
    this.requests = [];
    this.closed = false;
  }

  /** Counts requests to one path, for asserting on manifest caching. */
  countRequests(prefix) {
    return this.requests.filter((r) => r.startsWith(prefix)).length;
  }

  handle(pathname, params) {
    this.requests.push(pathname);
    if (pathname === "/health") {
      if (this.healthStatus !== 200) return { status: this.healthStatus, body: "not found" };
      return { status: 200, body: JSON.stringify({ ok: true, frame: this.frame }) };
    }
    if (pathname === "/tools") {
      if (!this.tools) return { status: 404, body: "<h1>404 Not Found</h1>" };
      return { status: 200, body: JSON.stringify(this.tools) };
    }
    if (pathname === "/state") {
      this.frame += this.framesPerPoll;
      for (const p of this.pending) p.pollsLeft -= 1;
      const done = this.pending.filter((p) => p.pollsLeft <= 0);
      for (const p of done) this.completedCommandId = Math.max(this.completedCommandId, p.id);
      this.pending = this.pending.filter((p) => p.pollsLeft > 0);
      return { status: 200, body: JSON.stringify(this.snapshot()) };
    }
    if (pathname === "/command") {
      const id = this.nextCommandId++;
      this.commands.push({ cmd: params.get("cmd"), params: Object.fromEntries(params) });
      if (params.get("cmd") === "close") this.closed = true;
      this.pending.push({ id, pollsLeft: this.applyAfterPolls });
      return { status: 200, body: JSON.stringify({ accepted: true, commandId: id, frame: this.frame }) };
    }
    return { status: 404, body: "no such path" };
  }

  snapshot() {
    const s = {
      frame: this.frame,
      paused: false,
      ui: { screen: this.screen, elements: [{ label: "Play", visible: true }] },
      events: this.commands.slice(-5).map((c) => ({ m: `cmd:${c.cmd}` })),
      game: { score: 42, state: "RUNNING" },
    };
    if (this.reportsCompletedCommandId) s.completedCommandId = this.completedCommandId;
    return s;
  }
}

/** An HTTP service that is not a game - the "someone else took the port" case. */
export class ForeignService {
  handle() {
    return { status: 404, body: "<html>Not Found</html>" };
  }
}

/**
 * Build a fetch that routes by port. A port absent from the map refuses the
 * connection, which is what an unused localhost port really does.
 */
export function fakeFetch(byPort) {
  const calls = [];
  const impl = async (url) => {
    const parsed = new URL(url);
    const port = Number(parsed.port);
    calls.push(url);
    const game = byPort[port];
    if (!game || game.closed === "gone") {
      throw new Error("connect ECONNREFUSED 127.0.0.1:" + port);
    }
    const { status, body } = game.handle(parsed.pathname, parsed.searchParams);
    return { ok: status >= 200 && status < 300, status, text: async () => body };
  };
  impl.calls = calls;
  return impl;
}

/** Real but tiny sleeps: the polling loops need wall-clock time to advance. */
export const fastSleep = () => new Promise((r) => setTimeout(r, 1));

export function testConfig(overrides = {}) {
  return {
    defaultPort: 7777,
    scanPorts: [7777, 7801, 7802],
    launchHint: "run-the-game --debug-port={port}",
    requestTimeoutMs: 500,
    commandTimeoutMs: 500,
    // The registry is off unless a test opts in, so no test can be influenced
    // by whatever games happen to be running on the machine it runs on.
    registryDir: "/nonexistent/game-bridge/instances",
    useRegistry: false,
    useScan: true,
    eager: false,
    ...overrides,
  };
}

// The bridge joins paths with node:path, so on Windows an entry's file path
// comes back with backslashes; the fake store is keyed by bare filename.
const basename = (path) => path.replace(/\\/g, "/").split("/").pop();

/** An in-memory registry directory, for tests that do opt in. */
export function fakeRegistry(files = {}) {
  const store = { ...files };
  return {
    store,
    io: {
      readdir: async (dir) => {
        if (dir !== "/registry") throw new Error("ENOENT");
        return Object.keys(store);
      },
      readFile: async (path) => {
        const name = basename(path);
        if (!(name in store)) throw new Error("ENOENT");
        return typeof store[name] === "string" ? store[name] : JSON.stringify(store[name]);
      },
      unlink: async (path) => {
        const name = basename(path);
        delete store[name];
      },
    },
  };
}

/** A manifest in the shape the README documents, for the happy path. */
export function sampleManifest(overrides = {}) {
  return {
    game: { name: "Sample Game", version: "2.3.4", protocol: 1 },
    toolsets: [
      {
        name: "play",
        description: "Drive the game as a player would.",
        tools: [
          {
            name: "drop",
            description: "Drop the held item at world x.",
            arguments: [{ name: "x", type: "number", required: true, description: "World x" }],
          },
          { name: "restart", description: "Restart the run." },
        ],
      },
    ],
    passthrough: { description: "Anything the game accepts.", examples: ["set_seed { seed }"] },
    ...overrides,
  };
}
