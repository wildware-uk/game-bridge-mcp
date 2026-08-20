import test from "node:test";
import assert from "node:assert/strict";

import { GameClient } from "../dist/client.js";
import { Bridge } from "../dist/bridge.js";
import { CommandTimeout, GameOffline } from "../dist/errors.js";
import { FakeGame, fakeFetch, fastSleep, sampleManifest, testConfig } from "./helpers.js";

function clientFor(byPort, port = 7801, opts = {}) {
  return new GameClient(port, {
    fetchImpl: fakeFetch(byPort),
    sleep: fastSleep,
    launchHint: "run-the-game --debug-port={port}",
    ...opts,
  });
}

test("commandAndSync waits for the game to report the command applied", async () => {
  // The command lands three polls after it is queued, which is the whole reason
  // this function exists: /command answers immediately, from a different thread.
  const game = new FakeGame({ applyAfterPolls: 3 });
  const client = clientFor({ 7801: game });

  const result = await client.commandAndSync("restart", {}, 2000);
  assert.equal(result.confirmed, true);
  assert.equal(result.commandId, 1);
  assert.ok(game.completedCommandId >= 1);
  assert.ok(game.countRequests("/state") >= 4, "it must poll, not trust the acknowledgement");
});

test("commandAndSync returns state from after the command, not before", async () => {
  const game = new FakeGame({ applyAfterPolls: 2 });
  const client = clientFor({ 7801: game });

  const { state } = await client.commandAndSync("restart", {}, 2000);
  assert.ok(state.events.some((e) => e.m === "cmd:restart"));
});

test("arguments are sent as query parameters alongside cmd", async () => {
  const game = new FakeGame();
  const client = clientFor({ 7801: game });

  await client.commandAndSync("spawn", { type: "CHERRY", x: -1.5, ignored: null }, 2000);
  assert.deepEqual(game.commands.at(-1).params, { cmd: "spawn", type: "CHERRY", x: "-1.5" });
});

test("a game with no completedCommandId falls back to watching frames", async () => {
  const game = new FakeGame({ reportsCompletedCommandId: false, framesPerPoll: 1 });
  const client = clientFor({ 7801: game });

  const result = await client.commandAndSync("restart", {}, 2000);
  // The weaker guarantee must be reported as such rather than passed off as a
  // real confirmation.
  assert.equal(result.confirmed, false);
});

test("a command that is never applied times out with a diagnosis", async () => {
  const game = new FakeGame({ applyAfterPolls: Number.MAX_SAFE_INTEGER });
  const client = clientFor({ 7801: game });

  await assert.rejects(() => client.commandAndSync("restart", {}, 60), (e) => {
    assert.ok(e instanceof CommandTimeout);
    assert.match(e.message, /queued on port 7801/);
    assert.match(e.message, /frozen, or on a screen that ignores this command/);
    return true;
  });
});

test("call_tool respects sync:false and does not wait", async () => {
  const tools = sampleManifest();
  tools.toolsets[0].tools.push({ name: "fire_and_forget", sync: false });
  const bridge = new Bridge(testConfig(), { fetchImpl: fakeFetch({ 7801: new FakeGame({ tools }) }), sleep: fastSleep });

  const result = await bridge.callTool(7801, "fire_and_forget", {});
  assert.equal(result.queued, true);
  assert.equal(result.applied, undefined);
});

test("close does not wait for a confirmation that can never arrive", async () => {
  const game = new FakeGame({ tools: sampleManifest() });
  const byPort = { 7801: game };
  const fetchImpl = async (url, init) => {
    const parsed = new URL(url);
    // The game stops answering once it has been told to close, exactly as a
    // real one does part-way through its shutdown.
    if (game.closed && parsed.pathname !== "/command") {
      throw new Error("connect ECONNREFUSED 127.0.0.1:7801");
    }
    return fakeFetch(byPort)(url, init);
  };
  const bridge = new Bridge(testConfig(), { fetchImpl, sleep: fastSleep });

  const result = await bridge.callTool(7801, "close", {});
  assert.deepEqual(result, { port: 7801, closed: true });
  assert.equal(game.commands.at(-1).cmd, "close");
});

test("closing a port that is already gone is not an error", async () => {
  const bridge = new Bridge(testConfig(), { fetchImpl: fakeFetch({}), sleep: fastSleep });
  const result = await bridge.callTool(7801, "close", {});
  assert.equal(result.closed, true);
  assert.match(result.note, /already gone/);
});

test("the command goes to the port it was addressed to, not the default", async () => {
  const a = new FakeGame({ tools: sampleManifest() });
  const b = new FakeGame({ tools: sampleManifest() });
  const bridge = new Bridge(testConfig({ defaultPort: 7801 }), {
    fetchImpl: fakeFetch({ 7801: a, 7802: b }),
    sleep: fastSleep,
  });

  await bridge.callTool(bridge.port(7802), "restart", {});
  assert.equal(b.commands.length, 1);
  assert.equal(a.commands.length, 0, "the default port must not receive a command aimed elsewhere");

  await bridge.callTool(bridge.port(undefined), "restart", {});
  assert.equal(a.commands.length, 1, "an unaddressed call goes to the default port");
});

test("a dead port raises GameOffline naming the launch command", async () => {
  const client = clientFor({});
  await assert.rejects(() => client.state(), (e) => {
    assert.ok(e instanceof GameOffline);
    assert.match(e.message, /No game is answering on http:\/\/127\.0\.0\.1:7801/);
    assert.match(e.message, /run-the-game --debug-port=7801/);
    return true;
  });
});
