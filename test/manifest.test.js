import test from "node:test";
import assert from "node:assert/strict";

import { Bridge } from "../dist/bridge.js";
import { normaliseManifest, toInputSchema, toolIndex } from "../dist/manifest.js";
import { FakeGame, fakeFetch, fastSleep, sampleManifest, testConfig } from "./helpers.js";


function bridgeFor(byPort, configOverrides = {}) {
  return new Bridge(testConfig(configOverrides), { fetchImpl: fakeFetch(byPort), sleep: fastSleep });
}

test("a game's manifest is used as published", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeFor({ 7801: game });

  const manifest = await bridge.manifest(7801);
  assert.equal(manifest.source, "game");
  assert.equal(manifest.game.name, "Sample Game");
  assert.equal(manifest.game.version, "2.3.4");
  assert.deepEqual(manifest.toolsets.map((s) => s.name), ["play"]);
  assert.ok(toolIndex(manifest).has("drop"));
});

test("the bridge's own toolset is offered alongside every game's", async () => {
  const bridge = bridgeFor({ 7801: new FakeGame({ tools: sampleManifest() }) });
  const described = await bridge.describeToolset(7801, "bridge");
  assert.deepEqual(
    described.tools.map((t) => t.name).sort(),
    ["close", "get_health", "get_state", "raw_command", "wait_for"]
  );
  assert.ok(described.tools.every((t) => t.from === "bridge"));

  const listed = await bridge.listToolsets(7801);
  assert.deepEqual(listed.toolsets.map((s) => s.name), ["play", "bridge"]);
});

test("a composite shadows a game command of the same name", async () => {
  // Shadowing is always an improvement here rather than a surprise: a composite
  // that carries a game command's name exists precisely because the raw command
  // returns before the thing it asked for has happened.
  const tools = sampleManifest();
  tools.toolsets[0].tools.push({ name: "get_state", description: "The raw command." });
  const game = new FakeGame({ tools });
  const bridge = bridgeFor({ 7801: game });

  const result = await bridge.callTool(7801, "get_state", { summary: true });
  assert.equal(result.port, 7801);
  assert.equal(game.commands.length, 0, "it must not have been sent as a command");
});

test("composites can be added by a host application, and only for the games they suit", async () => {
  const config = testConfig();
  const bridge = new Bridge(config, {
    fetchImpl: fakeFetch({ 7801: new FakeGame({ tools: sampleManifest() }) }),
    sleep: fastSleep,
    composites: [
      { name: "stack_crates", description: "Only makes sense for one game.", only: "Orbital Freight", run: async () => ({ ok: true }) },
      { name: "double_restart", description: "Any game.", async run(ctx) {
          await ctx.commandAndSync("restart");
          await ctx.commandAndSync("restart");
          return { restarts: 2 };
      } },
    ],
  });

  const names = (await bridge.describeToolset(7801, "bridge")).tools.map((t) => t.name);
  assert.ok(names.includes("double_restart"));
  assert.ok(!names.includes("stack_crates"), "a composite for another game must not be offered here");
  assert.deepEqual(await bridge.callTool(7801, "double_restart", {}), { restarts: 2 });
});

test("GET /tools returning 404 degrades to the fallback manifest, not an error", async () => {
  const game = new FakeGame({ tools: null });
  const bridge = bridgeFor({ 7801: game });

  const manifest = await bridge.manifest(7801);
  assert.equal(manifest.source, "fallback");
  // The fallback advertises no game-specific commands at all - the bridge has
  // no business guessing them - but the instance is still fully drivable
  // through the bridge toolset and passthrough.
  assert.deepEqual(manifest.toolsets, []);
  assert.deepEqual(
    (await bridge.listToolsets(7801)).toolsets.map((s) => s.name),
    ["bridge"]
  );
  assert.match(manifest.passthrough.description, /does not serve GET \/tools/);
});

test("an older game with no /tools is still drivable end to end", async () => {
  const game = new FakeGame({ tools: null });
  const bridge = bridgeFor({ 7801: game });

  const result = await bridge.callTool(7801, "spawn", { type: "CHERRY", x: 0.5 });
  assert.equal(result.via, "passthrough");
  assert.equal(result.applied, true);
  assert.deepEqual(game.commands.at(-1).params, { cmd: "spawn", type: "CHERRY", x: "0.5" });
});

test("the manifest is fetched once per port and then cached", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeFor({ 7801: game });

  await bridge.manifest(7801);
  await bridge.manifest(7801);
  await bridge.listToolsets(7801);
  assert.equal(game.countRequests("/tools"), 1);
});

test("refresh re-fetches the manifest", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeFor({ 7801: game });

  await bridge.manifest(7801);
  await bridge.manifest(7801, { refresh: true });
  assert.equal(game.countRequests("/tools"), 2);
});

test("caching is per port: two instances do not share a manifest", async () => {
  const a = new FakeGame({ tools: sampleManifest({ game: { name: "Game A", version: "1" } }) });
  const b = new FakeGame({ tools: sampleManifest({ game: { name: "Game B", version: "2" } }) });
  const bridge = bridgeFor({ 7801: a, 7802: b });

  assert.equal((await bridge.manifest(7801)).game.name, "Game A");
  assert.equal((await bridge.manifest(7802)).game.name, "Game B");
  assert.equal(a.countRequests("/tools"), 1);
  assert.equal(b.countRequests("/tools"), 1);
});

test("a tool the cached manifest does not know triggers exactly one re-fetch", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeFor({ 7801: game });
  await bridge.manifest(7801);

  // The game gains a command, as it does when someone rebuilds it mid-session.
  const grown = sampleManifest();
  grown.toolsets[0].tools.push({ name: "teleport", command: "warp" });
  game.tools = grown;

  const result = await bridge.callTool(7801, "teleport", { x: 1 });
  assert.equal(game.countRequests("/tools"), 2);
  assert.equal(result.via, "manifest");
  assert.equal(result.command, "warp", "a tool may map to a differently named command");
  assert.equal(game.commands.at(-1).cmd, "warp");
});

test("a restarted game on the same port invalidates the cached manifest", async () => {
  const game = new FakeGame({ tools: sampleManifest(), frame: 5000 });
  const bridge = bridgeFor({ 7801: game });
  await bridge.callTool(7801, "get_health", {});
  assert.equal(game.countRequests("/tools"), 1);

  // Frames only ever move forwards within one process, so going backwards means
  // a new process is answering on this port.
  game.frame = 3;
  game.tools = sampleManifest({ game: { name: "Rebuilt Game", version: "9" } });
  await bridge.callTool(7801, "get_health", {});

  assert.equal((await bridge.manifest(7801)).game.name, "Rebuilt Game");
  assert.equal(game.countRequests("/tools"), 2);
});

test("normalisation accepts toolsets as a map as well as an array", () => {
  const manifest = normaliseManifest(
    {
      game: { name: "Map Game" },
      toolsets: {
        play: { description: "play things", tools: ["drop", { name: "aim", arguments: { x: { type: "number" } } }] },
      },
    },
    7801
  );
  assert.deepEqual(manifest.toolsets.map((s) => s.name), ["play"]);
  const aim = toolIndex(manifest).get("aim");
  assert.deepEqual(toInputSchema(aim), { type: "object", properties: { x: { type: "number" } } });
});

test("normalisation drops malformed tools rather than failing the whole instance", () => {
  const manifest = normaliseManifest(
    { toolsets: [{ name: "play", tools: [{ description: "no name" }, null, 7, { name: "ok" }] }] },
    7801
  );
  assert.deepEqual(manifest.toolsets[0].tools.map((t) => t.name), ["ok"]);
});

test("normalisation passes a game-supplied inputSchema straight through", () => {
  const schema = { type: "object", properties: { n: { type: "integer" } }, required: ["n"] };
  const manifest = normaliseManifest(
    { toolsets: [{ name: "x", tools: [{ name: "t", inputSchema: schema }] }] },
    7801
  );
  assert.deepEqual(toInputSchema(toolIndex(manifest).get("t")), schema);
});

test("describe_toolset expands arguments into JSON Schema", async () => {
  const bridge = bridgeFor({ 7801: new FakeGame({ tools: sampleManifest() }) });
  const described = await bridge.describeToolset(7801, "play");
  const drop = described.tools.find((t) => t.name === "drop");
  assert.deepEqual(drop.inputSchema, {
    type: "object",
    properties: { x: { type: "number", description: "World x" } },
    required: ["x"],
  });
  assert.equal(drop.from, "game");
});

test("describe_toolset names the alternatives when the toolset does not exist", async () => {
  const bridge = bridgeFor({ 7801: new FakeGame({ tools: sampleManifest() }) });
  const described = await bridge.describeToolset(7801, "nope");
  assert.match(described.error, /no toolset 'nope'/);
  assert.deepEqual(described.available, ["play", "bridge", "passthrough"]);
});
