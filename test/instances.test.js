import test from "node:test";
import assert from "node:assert/strict";

import { Bridge } from "../dist/bridge.js";
import { NotAGameSurface } from "../dist/errors.js";
import { GameClient } from "../dist/client.js";
import { readRegistry } from "../dist/registry.js";
import {
  FakeGame,
  ForeignService,
  fakeFetch,
  fakeRegistry,
  fastSleep,
  sampleManifest,
  testConfig,
} from "./helpers.js";

const byPort = (found) => Object.fromEntries(found.map((i) => [i.port, i]));

test("a port scan separates live games, foreign services and free ports", async () => {
  const game = new FakeGame({ tools: sampleManifest(), screen: "GameScreen", frame: 900 });
  const bridge = new Bridge(testConfig({ scanPorts: [7777, 7801, 7802] }), {
    fetchImpl: fakeFetch({ 7801: game, 7802: new ForeignService() }),
    sleep: fastSleep,
  });

  const { instances } = await bridge.listInstances();
  const found = byPort(instances);

  assert.equal(found[7777].status, "free");
  assert.equal(found[7801].status, "live");
  assert.equal(found[7801].discovery, "scan");
  assert.equal(found[7801].game, "Sample Game");
  assert.equal(found[7801].version, "2.3.4");
  assert.equal(found[7801].screen, "GameScreen");
  assert.deepEqual(found[7801].toolsets, ["play", "bridge"]);
  assert.equal(found[7801].manifest, "game");

  // A port taken by something that is not a game is its own answer, because the
  // fix for it - find out what else is listening - is nothing like the fix for
  // a game that is not running.
  assert.equal(found[7802].status, "not-a-game");
  assert.match(found[7802].detail, /not a debuggable game/);
});

test("discovery is read-only: no instance receives a command", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = new Bridge(testConfig({ scanPorts: [7801] }), {
    fetchImpl: fakeFetch({ 7801: game }),
    sleep: fastSleep,
  });

  await bridge.listInstances();
  assert.equal(game.commands.length, 0);
  assert.equal(game.countRequests("/command"), 0);
});

test("a game predating /tools reports as live-no-manifest, not as broken", async () => {
  const bridge = new Bridge(testConfig({ scanPorts: [7801] }), {
    fetchImpl: fakeFetch({ 7801: new FakeGame({ tools: null, screen: "MenuScreen" }) }),
    sleep: fastSleep,
  });

  const [instance] = (await bridge.listInstances()).instances;
  assert.equal(instance.status, "live-no-manifest");
  assert.equal(instance.manifest, "fallback");
  assert.equal(instance.screen, "MenuScreen");
});

test("an explicit range overrides the configured scan range", async () => {
  const bridge = new Bridge(testConfig({ scanPorts: [7777] }), {
    fetchImpl: fakeFetch({ 7805: new FakeGame({ tools: sampleManifest() }) }),
    sleep: fastSleep,
  });

  const { instances } = await bridge.listInstances({ ports: [7804, 7805] });
  assert.deepEqual(instances.map((i) => i.port), [7804, 7805]);
  assert.equal(instances[1].status, "live");
});

// --------------------------------------------------------------- registry

test("the registry finds instances outside the scanned range", async () => {
  const registry = fakeRegistry({
    "4242.json": {
      name: "Registered Game",
      version: "3.1",
      protocol: 1,
      port: 7899,
      pid: 4242,
      cwd: "/checkouts/main",
      started: "2026-08-20T09:00:00Z",
    },
  });
  const bridge = new Bridge(
    testConfig({ scanPorts: [7801], registryDir: "/registry", useRegistry: true }),
    {
      fetchImpl: fakeFetch({ 7899: new FakeGame({ tools: sampleManifest({ game: { name: "Registered Game", version: "3.1" } }) }) }),
      sleep: fastSleep,
      registryIo: registry.io,
    }
  );

  const found = byPort((await bridge.listInstances()).instances);
  assert.equal(found[7899].status, "live");
  assert.equal(found[7899].discovery, "registry");
  assert.equal(found[7899].pid, 4242);
  // cwd answers "which checkout is this build from", which nothing on the wire
  // can tell you.
  assert.equal(found[7899].cwd, "/checkouts/main");
  assert.equal(found[7899].started, "2026-08-20T09:00:00Z");
});

test("a registry entry whose port is dead is stale, not a running game", async () => {
  const registry = fakeRegistry({
    "999.json": { name: "Crashed Game", port: 7898, pid: 999 },
  });
  const bridge = new Bridge(
    testConfig({ scanPorts: [], registryDir: "/registry", useRegistry: true }),
    { fetchImpl: fakeFetch({}), sleep: fastSleep, registryIo: registry.io }
  );

  const [entry] = (await bridge.listInstances()).instances;
  assert.equal(entry.status, "free");
  assert.equal(entry.stale, true);
  assert.match(entry.entryFile, /999\.json$/);
  assert.equal(entry.pruned, undefined, "stale entries are not deleted unless asked");
  assert.deepEqual(Object.keys(registry.store), ["999.json"]);
});

test("pruning deletes only entries verified dead", async () => {
  const registry = fakeRegistry({
    "999.json": { name: "Crashed Game", port: 7898, pid: 999 },
    "1000.json": { name: "Live Game", port: 7899, pid: 1000 },
  });
  const bridge = new Bridge(
    testConfig({ scanPorts: [], registryDir: "/registry", useRegistry: true }),
    {
      fetchImpl: fakeFetch({ 7899: new FakeGame({ tools: sampleManifest() }) }),
      sleep: fastSleep,
      registryIo: registry.io,
    }
  );

  const found = byPort((await bridge.listInstances({ prune: true })).instances);
  assert.equal(found[7898].pruned, true);
  assert.equal(found[7899].status, "live");
  assert.deepEqual(Object.keys(registry.store), ["1000.json"]);
});

test("a port found by both the registry and the scan is reported once", async () => {
  const registry = fakeRegistry({ "77.json": { name: "Both Ways", port: 7801, pid: 77 } });
  const bridge = new Bridge(
    testConfig({ scanPorts: [7801], registryDir: "/registry", useRegistry: true }),
    {
      fetchImpl: fakeFetch({ 7801: new FakeGame({ tools: sampleManifest() }) }),
      sleep: fastSleep,
      registryIo: registry.io,
    }
  );

  const { instances } = await bridge.listInstances();
  assert.equal(instances.length, 1);
  assert.equal(instances[0].discovery, "both");
  assert.equal(instances[0].pid, 77);
  // The live game is authoritative about its own identity; the entry only fills
  // in what the wire cannot say.
  assert.equal(instances[0].game, "Sample Game");
});

test("a half-written or malformed entry does not break discovery", async () => {
  const registry = fakeRegistry({
    "broken.json": "{ this is not json",
    "noport.json": { name: "No Port" },
    "good.json": { name: "Good", port: 7801 },
  });
  const read = await readRegistry("/registry", registry.io);
  assert.deepEqual(read.entries.map((e) => e.port), [7801]);
  assert.equal(read.unreadable.length, 2);
});

test("two entries for one port keep the newer one", async () => {
  const registry = fakeRegistry({
    "1.json": { name: "Old", port: 7801, started: "2026-01-01T00:00:00Z" },
    "2.json": { name: "New", port: 7801, started: "2026-08-01T00:00:00Z" },
  });
  const read = await readRegistry("/registry", registry.io);
  assert.equal(read.entries.length, 1);
  assert.equal(read.entries[0].name, "New");
});

test("a missing registry directory is silence, not an error", async () => {
  const read = await readRegistry("/no/such/dir", fakeRegistry().io);
  assert.deepEqual(read.entries, []);
});

// ------------------------------------------------------- port identification

test("health on a non-game surface is reported as such, not as offline", async () => {
  const client = new GameClient(7802, { fetchImpl: fakeFetch({ 7802: new ForeignService() }), sleep: fastSleep });
  await assert.rejects(() => client.health(), (e) => {
    assert.ok(e instanceof NotAGameSurface);
    assert.match(e.message, /GET \/health returned HTTP 404/);
    assert.match(e.message, /another process has taken this port/);
    return true;
  });
});

test("a service that answers /health with something other than ok:true is not a game", async () => {
  const notOurs = { handle: () => ({ status: 200, body: JSON.stringify({ status: "UP" }) }) };
  const client = new GameClient(7802, { fetchImpl: fakeFetch({ 7802: notOurs }), sleep: fastSleep });
  await assert.rejects(() => client.health(), NotAGameSurface);
});

test("a service answering HTML on /state is not mistaken for a broken game", async () => {
  const htmlServer = { handle: () => ({ status: 200, body: "<!doctype html><h1>hello</h1>" }) };
  const client = new GameClient(7802, { fetchImpl: fakeFetch({ 7802: htmlServer }), sleep: fastSleep });
  await assert.rejects(() => client.state(), NotAGameSurface);
});
