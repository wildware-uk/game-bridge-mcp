import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Launcher, findProjectConfig, ephemeralPort, portIsFree, DEFAULT_LAUNCH_RANGE } from "../dist/launcher.js";
import { BridgeUsageError } from "../dist/errors.js";

/** A child process that never really existed: emits what we tell it to. */
function fakeChild(pid = 4242) {
  const child = new EventEmitter();
  child.pid = pid;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = (signal) => {
    child.killedWith = signal;
    return true;
  };
  return child;
}

function fakeSpawn(child, record = []) {
  return (...args) => {
    record.push(args);
    return child;
  };
}

const noSleep = () => new Promise((r) => setTimeout(r, 1));

async function tempLogDir() {
  return mkdtemp(join(tmpdir(), "gb-test-"));
}

test("launch substitutes {port} and waits for the game to answer", async () => {
  const child = fakeChild();
  const record = [];
  let healthChecks = 0;
  const launcher = new Launcher({
    spawnImpl: fakeSpawn(child, record),
    sleep: noSleep,
    logDir: await tempLogDir(),
    // The game is not up on the first check; a launcher that returned before
    // /health answered would hand back a port nothing is listening on yet.
    health: async () => ++healthChecks >= 3,
  });

  const instance = await launcher.launch({
    command: "run-game --debug-port={port}",
    cwd: process.cwd(),
    portRange: "7890-7899",
  });

  assert.match(instance.command, /--debug-port=78\d\d/);
  assert.equal(instance.command.includes("{port}"), false);
  assert.equal(instance.pid, 4242);
  assert.ok(healthChecks >= 3, "it must poll until the game is actually up");
  assert.equal(record[0][1].shell, true);
});

test("a game that dies during boot fails with its own output, not a timeout", async () => {
  const child = fakeChild();
  const launcher = new Launcher({
    spawnImpl: fakeSpawn(child),
    sleep: noSleep,
    logDir: await tempLogDir(),
    health: async () => false,
  });

  setTimeout(() => {
    child.stderr.emit("data", "Exception in thread main: java.lang.NoSuchMethodError\n\tat Game.create\n");
    child.emit("exit", 1, null);
  }, 20);

  await assert.rejects(
    () => launcher.launch({ command: "run-game --debug-port={port}", portRange: "7890-7890", readyTimeoutMs: 5000 }),
    (e) => {
      assert.ok(e instanceof BridgeUsageError);
      assert.match(e.message, /exited with code 1/);
      // When a game fails to boot the stack trace is the entire answer, and it
      // is otherwise visible only to whoever is tailing a log.
      assert.match(e.message, /NoSuchMethodError/);
      assert.match(e.message, /Full log:/);
      return true;
    }
  );
});

test("a game that never answers fails with a timeout naming the log", async () => {
  const child = fakeChild();
  const launcher = new Launcher({
    spawnImpl: fakeSpawn(child),
    sleep: noSleep,
    logDir: await tempLogDir(),
    health: async () => false,
  });

  await assert.rejects(
    () => launcher.launch({ command: "run-game {port}", portRange: "7890-7890", readyTimeoutMs: 50 }),
    (e) => {
      assert.match(e.message, /did not answer GET \/health within 50ms/);
      return true;
    }
  );
});

test("the launcher will not claim a port that already has a game on it", async () => {
  const taken = new Set([7890, 7891]);
  const launcher = new Launcher({
    sleep: noSleep,
    // Ports 7890 and 7891 answer a health check: something is already there,
    // even though a bind test a moment earlier might have said otherwise.
    health: async (port) => taken.has(port),
  });

  const port = await launcher.pickPort("7890-7893");
  assert.ok(!taken.has(port));
  assert.ok(port >= 7892 && port <= 7893);
});

test("the launcher skips excluded ports", async () => {
  const launcher = new Launcher({ sleep: noSleep, health: async () => false });
  const port = await launcher.pickPort("7890-7892", [7890, 7891]);
  assert.equal(port, 7892);
});

test("the default launch range stays clear of the conventional ports", () => {
  // 7777 and 7800-7810 are the ports people hand out by hand, so a launcher
  // grabbing from there would take one out from under a colleague.
  const [lo, hi] = DEFAULT_LAUNCH_RANGE.split("-").map(Number);
  assert.ok(lo > 7810, "the launch range must not overlap the hand-allocated block");
  assert.ok(hi > lo);
});

test("a real free port can be found and is actually free", async () => {
  const port = await ephemeralPort();
  assert.ok(port > 1024);
  assert.equal(await portIsFree(port), true);
});

test("stop asks the game to close before it insists", async () => {
  const child = fakeChild();
  const launcher = new Launcher({
    spawnImpl: fakeSpawn(child),
    sleep: noSleep,
    logDir: await tempLogDir(),
    health: async () => true,
  });
  const instance = await launcher.launch({ command: "run-game {port}", portRange: "7890-7890" });

  let closeCalled = false;
  const stopping = launcher.stop(instance.port, {
    grace: 2000,
    closeCommand: async () => {
      closeCalled = true;
      setTimeout(() => child.emit("exit", 0, null), 10);
    },
  });

  const result = await stopping;
  assert.equal(closeCalled, true);
  assert.equal(result.stopped, true);
  assert.match(result.how, /closed cleanly/);
  assert.equal(child.killedWith, undefined, "a game that closed cleanly must never be killed");
});

test("stop refuses a port this bridge did not launch", async () => {
  const launcher = new Launcher({ sleep: noSleep });
  await assert.rejects(() => launcher.stop(7777), (e) => {
    assert.ok(e instanceof BridgeUsageError);
    // Killing a process we did not start is never this tool's business.
    assert.match(e.message, /did not launch anything on port 7777/);
    assert.match(e.message, /call_tool \{ port: 7777, name: "close" \}/);
    return true;
  });
});

test("shutdownAll reaps every child, so no game window outlives the session", async () => {
  const children = [fakeChild(1), fakeChild(2)];
  let n = 0;
  const launcher = new Launcher({
    spawnImpl: () => children[n++],
    sleep: noSleep,
    logDir: await tempLogDir(),
    health: async () => true,
  });
  const a = await launcher.launch({ command: "g {port}" }, { port: 7890 });
  const b = await launcher.launch({ command: "g {port}" }, { port: 7891 });
  assert.equal(launcher.list().length, 2);

  await launcher.shutdownAll(async (port) => {
    const child = port === a.port ? children[0] : children[1];
    setTimeout(() => child.emit("exit", 0, null), 5);
  });

  assert.equal(launcher.list().length, 0);
  assert.equal(b.port, 7891);
});

test("launching without a command says exactly what to write", async () => {
  const launcher = new Launcher({ sleep: noSleep });
  await assert.rejects(() => launcher.launch({}), (e) => {
    assert.match(e.message, /gamebridge\.json/);
    assert.match(e.message, /\{port\}/);
    return true;
  });
});

test("the project config is found by walking up from a subdirectory", async () => {
  const root = await mkdtemp(join(tmpdir(), "gb-project-"));
  const nested = join(root, "a", "b");
  await mkdir(nested, { recursive: true });
  await writeFile(
    join(root, "gamebridge.json"),
    JSON.stringify({ name: "Test Game", launch: { command: "run {port}", cwd: "." } })
  );

  const found = await findProjectConfig(nested);
  assert.equal(found.name, "Test Game");
  assert.equal(found.launch.command, "run {port}");
  assert.match(found.file, /gamebridge\.json$/);
});

test("no project config anywhere is not an error", async () => {
  const empty = await mkdtemp(join(tmpdir(), "gb-empty-"));
  // Walking up from a temp directory reaches the filesystem root without
  // finding one, and attaching to a game someone else started is a perfectly
  // good way to use the bridge.
  const found = await findProjectConfig(empty, undefined);
  assert.ok(found === null || typeof found === "object");
});

test("an explicit config path that does not exist is reported clearly", async () => {
  await assert.rejects(() => findProjectConfig(process.cwd(), "no-such-config.json"), BridgeUsageError);
});
