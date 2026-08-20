import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createServer } from "../dist/server.js";
import { FakeGame, fakeFetch, fastSleep, sampleManifest, testConfig } from "./helpers.js";



/**
 * Drives the real MCP surface rather than the Bridge class directly, because
 * the thing that actually has to work is what an agent sees over the protocol.
 */
async function connect(byPort, configOverrides = {}) {
  const { server } = createServer(testConfig(configOverrides), {
    fetchImpl: fakeFetch(byPort),
    sleep: fastSleep,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "1.0.0" }, { capabilities: {} });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return {
    client,
    async call(name, args) {
      const res = await client.callTool({ name, arguments: args });
      return { isError: res.isError === true, data: safeParse(res.content[0].text), raw: res.content[0].text };
    },
    async close() {
      await client.close();
      await server.close();
    },
  };
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

test("the advertised surface is lifecycle plus discovery, and is port-addressable", async (t) => {
  const session = await connect({});
  t.after(() => session.close());

  const { tools } = await session.client.listTools();
  assert.deepEqual(
    tools.map((tool) => tool.name).sort(),
    [
      "call_tool",
      "describe_toolset",
      "instance_log",
      "launch_instance",
      "list_instances",
      "list_toolsets",
      "stop_instance",
    ]
  );
  // Everything that addresses an instance takes a port. list_instances is the
  // one that finds them, and launch_instance is the one that chooses.
  for (const tool of tools) {
    if (tool.name === "list_instances") continue;
    assert.ok(tool.inputSchema.properties.port, `${tool.name} must accept a port`);
  }
});

test("launch_instance without a project config explains what to write", async (t) => {
  const session = await connect({});
  t.after(() => session.close());

  const result = await session.call("launch_instance", {});
  assert.equal(result.isError, true);
  assert.match(result.raw, /gamebridge\.json/);
});

test("stop_instance refuses a port this bridge did not launch", async (t) => {
  const session = await connect({ 7801: new FakeGame({ tools: sampleManifest() }) });
  t.after(() => session.close());

  const result = await session.call("stop_instance", { port: 7801 });
  assert.equal(result.isError, true);
  assert.match(result.raw, /did not launch anything on port 7801/);
  assert.match(result.raw, /name: "close"/);
});

test("two instances are driven independently in one session", async (t) => {
  const a = new FakeGame({ tools: sampleManifest({ game: { name: "Instance A", version: "1" } }) });
  const b = new FakeGame({ tools: sampleManifest({ game: { name: "Instance B", version: "2" } }) });
  const session = await connect({ 7801: a, 7802: b }, { defaultPort: 7801, scanPorts: [7777, 7801, 7802] });
  t.after(() => session.close());

  const listA = await session.call("list_toolsets", { port: 7801 });
  const listB = await session.call("list_toolsets", { port: 7802 });
  assert.equal(listA.data.game.name, "Instance A");
  assert.equal(listB.data.game.name, "Instance B");

  await session.call("call_tool", { port: 7802, name: "drop", arguments: { x: 1.25 } });
  assert.equal(a.commands.length, 0);
  assert.deepEqual(b.commands.at(-1).params, { cmd: "drop", x: "1.25" });

  const scan = await session.call("list_instances", {});
  assert.equal(scan.data.live.length, 2);
  assert.deepEqual(scan.data.free, [7777]);
  assert.deepEqual(scan.data.live.map((i) => i.game).sort(), ["Instance A", "Instance B"]);
});

test("a call with no port lands on the configured default", async (t) => {
  const a = new FakeGame({ tools: sampleManifest() });
  const b = new FakeGame({ tools: sampleManifest() });
  const session = await connect({ 7801: a, 7802: b }, { defaultPort: 7802 });
  t.after(() => session.close());

  await session.call("call_tool", { name: "restart" });
  assert.equal(b.commands.length, 1);
  assert.equal(a.commands.length, 0);
});

test("errors come back as tool errors with the diagnosis intact", async (t) => {
  const session = await connect({}, { defaultPort: 7801 });
  t.after(() => session.close());

  const dead = await session.call("call_tool", { port: 7809, name: "restart" });
  assert.equal(dead.isError, true);
  assert.match(dead.raw, /GameOffline/);
  assert.match(dead.raw, /run-the-game --debug-port=7809/);

  const badPort = await session.call("list_toolsets", { port: 99999 });
  assert.equal(badPort.isError, true);
  assert.match(badPort.raw, /not a valid TCP port/);
});

test("an unpublished command still reaches the game through passthrough", async (t) => {
  const game = new FakeGame({ tools: sampleManifest() });
  const session = await connect({ 7801: game }, { defaultPort: 7801 });
  t.after(() => session.close());

  const result = await session.call("call_tool", {
    name: "set_seed",
    arguments: { seed: 12345 },
  });
  assert.equal(result.data.via, "passthrough");
  assert.deepEqual(game.commands.at(-1).params, { cmd: "set_seed", seed: "12345" });
});

test("get_state summary is compact and game-agnostic", async (t) => {
  const game = new FakeGame({ tools: sampleManifest(), screen: "GameScreen" });
  const session = await connect({ 7801: game }, { defaultPort: 7801 });
  t.after(() => session.close());

  const full = await session.call("call_tool", { name: "get_state" });
  assert.ok(full.data.ui.elements, "the full snapshot is passed through untouched");

  const summary = await session.call("call_tool", { name: "get_state", arguments: { summary: true } });
  assert.equal(summary.data.port, 7801);
  assert.equal(summary.data.screen, "GameScreen");
  assert.deepEqual(summary.data.elements, ["Play"]);
  assert.deepEqual(summary.data.game, { score: 42, state: "RUNNING" });
});
