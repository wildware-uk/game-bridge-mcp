import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { Bridge } from "../dist/bridge.js";
import { createServer } from "../dist/server.js";
import { normaliseManifest, toInputSchema, toolIndex } from "../dist/manifest.js";
import { FakeGame, fakeFetch, fastSleep, sampleManifest, testConfig } from "./helpers.js";

/**
 * The manifest exactly as a game serialises it from a typed language: `args`
 * rather than `arguments`, every default rendered as a string, `null` for "no
 * default", and a `protocol` field versioning the document.
 */
const REAL_WORLD_MANIFEST = {
  game: { name: "Some Game", version: "0.0.1", protocol: 1 },
  toolsets: [
    {
      name: "play",
      description: "Drive the game the way a player does.",
      tools: [
        {
          name: "aim",
          description: "Pin the held item at a world x without releasing it.",
          args: [
            { name: "x", type: "number", description: "World x", required: true, default: null },
          ],
        },
        {
          name: "touch",
          description: "Inject a pointer event.",
          args: [
            { name: "x", type: "integer", description: "Screen x in pixels", required: true, default: null },
            { name: "action", type: "string", description: "down, drag, up or cancel", required: false, default: "down" },
          ],
        },
      ],
    },
  ],
};

test("a manifest using 'args' and stringy defaults converts to clean JSON Schema", () => {
  const manifest = normaliseManifest(REAL_WORLD_MANIFEST, 7801);
  assert.equal(manifest.game.protocol, 1);

  const aim = toInputSchema(toolIndex(manifest).get("aim"));
  assert.deepEqual(aim, {
    type: "object",
    properties: { x: { type: "number", description: "World x" } },
    required: ["x"],
  });

  const touch = toInputSchema(toolIndex(manifest).get("touch"));
  // A default of "down" on a string is fine, but it is folded into the text
  // rather than emitted as `default`, because a manifest from a typed language
  // renders every default as a string and `default: "false"` on a boolean is a
  // schema a strict client may reject.
  assert.equal(touch.properties.action.description, "down, drag, up or cancel (default down)");
  assert.equal("default" in touch.properties.action, false);
  // `default: null` means "no default" and must not appear as one.
  assert.equal(touch.properties.x.description, "Screen x in pixels");
  assert.deepEqual(touch.required, ["x"]);
});

test("a manifest from a newer protocol is read anyway, with a warning attached", async () => {
  const future = { ...REAL_WORLD_MANIFEST, game: { name: "Future Game", protocol: 99 } };
  const bridge = new Bridge(testConfig(), {
    fetchImpl: fakeFetch({ 7801: new FakeGame({ tools: future }) }),
    sleep: fastSleep,
  });

  const manifest = await bridge.manifest(7801);
  assert.match(manifest.passthrough.description, /publishes manifest protocol 99/);
  assert.ok(toolIndex(manifest).has("aim"), "best-effort reading still finds the tools");
});

test("the port may be given inside arguments, and is never sent as a command argument", async (t) => {
  const a = new FakeGame({ tools: sampleManifest() });
  const b = new FakeGame({ tools: sampleManifest() });
  const { server } = createServer(testConfig({ defaultPort: 7801 }), {
    fetchImpl: fakeFetch({ 7801: a, 7802: b }),
    sleep: fastSleep,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  await client.callTool({ name: "call_tool", arguments: { name: "drop", arguments: { port: 7802, x: 1 } } });
  assert.equal(a.commands.length, 0, "the nested port must address the call");
  assert.deepEqual(b.commands.at(-1).params, { cmd: "drop", x: "1" });
});

test("eager mode advertises every tool flatly for clients that cannot discover", async (t) => {
  const game = new FakeGame({ tools: sampleManifest() });
  const { server } = createServer(testConfig({ defaultPort: 7801, eager: true }), {
    fetchImpl: fakeFetch({ 7801: game }),
    sleep: fastSleep,
  });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(ct), server.connect(st)]);
  t.after(async () => {
    await client.close();
    await server.close();
  });

  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.ok(names.includes("drop"), "the game's own tools are advertised");
  assert.ok(names.includes("get_state"), "so are the bridge's");
  assert.ok(names.includes("call_tool"), "the discovery tools remain");

  // A flat call still has to reach the right instance.
  const res = await client.callTool({ name: "drop", arguments: { x: 2, port: 7801 } });
  assert.equal(res.isError, undefined);
  assert.deepEqual(game.commands.at(-1).params, { cmd: "drop", x: "2" });
});

// ------------------------------------------------------------------ wait_for

function bridgeWith(game) {
  return new Bridge(testConfig(), { fetchImpl: fakeFetch({ 7801: game }), sleep: fastSleep });
}

test("wait_for matches when an event appears", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeWith(game);
  // The command that starts a screenshot cannot report the file landing, which
  // is exactly the gap wait_for closes.
  await bridge.callTool(7801, "raw_command", { cmd: "screenshot", sync: false });

  const result = await bridge.callTool(7801, "wait_for", { event: "cmd:screenshot", timeoutMs: 2000 });
  assert.equal(result.matched, true);
  assert.match(result.matchedOn, /event contains 'cmd:screenshot'/);
});

test("wait_for matches when a numeric field reaches a threshold", async () => {
  const game = new FakeGame({ tools: sampleManifest(), frame: 100, framesPerPoll: 5 });
  const bridge = bridgeWith(game);

  const result = await bridge.callTool(7801, "wait_for", { path: "frame", atLeast: 130, timeoutMs: 3000, pollMs: 1 });
  assert.equal(result.matched, true);
  assert.ok(result.value >= 130);
  assert.ok(result.polls > 1);
});

test("wait_for gives up rather than hanging, and says so", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const bridge = bridgeWith(game);

  const result = await bridge.callTool(7801, "wait_for", {
    path: "game.score",
    equals: 999999,
    timeoutMs: 60,
    pollMs: 5,
  });
  assert.equal(result.matched, false);
  assert.equal(result.matchedOn, undefined);
  assert.equal(result.value, 42);
});

test("wait_for needs something to wait for", async () => {
  const bridge = bridgeWith(new FakeGame({ tools: sampleManifest() }));
  await assert.rejects(() => bridge.callTool(7801, "wait_for", {}), /needs 'path'/);
});
