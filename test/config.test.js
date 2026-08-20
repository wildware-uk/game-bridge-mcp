import test from "node:test";
import assert from "node:assert/strict";

import { parseCli, parsePortRange, resolvePort, validPort, DEFAULT_PORT } from "../dist/config.js";
import { BridgeUsageError } from "../dist/errors.js";
import { testConfig } from "./helpers.js";

test("port resolution: explicit argument beats every default", () => {
  const config = testConfig({ defaultPort: 7801 });
  assert.equal(resolvePort(7805, config), 7805);
  assert.equal(resolvePort("7805", config), 7805);
});

test("port resolution: falls back to the CLI flag, then the env var, then 7777", () => {
  const fromFlag = parseCli(["--port", "7802"], {}).config;
  assert.equal(resolvePort(undefined, fromFlag), 7802);

  const fromEnv = parseCli([], { GAME_BRIDGE_PORT: "7803" }).config;
  assert.equal(resolvePort(undefined, fromEnv), 7803);

  const bare = parseCli([], {}).config;
  assert.equal(resolvePort(undefined, bare), DEFAULT_PORT);
  assert.equal(DEFAULT_PORT, 7777);
});

test("port resolution: the flag wins over the env var", () => {
  const { config } = parseCli(["--port", "7804"], { GAME_BRIDGE_PORT: "7803" });
  assert.equal(resolvePort(undefined, config), 7804);
  // ...and an explicit argument still wins over the flag.
  assert.equal(resolvePort(7805, config), 7805);
});

test("port resolution: empty and null are treated as 'not specified'", () => {
  const config = testConfig({ defaultPort: 7801 });
  assert.equal(resolvePort(undefined, config), 7801);
  assert.equal(resolvePort(null, config), 7801);
  assert.equal(resolvePort("", config), 7801);
});

test("invalid ports are rejected with a usable message", () => {
  assert.throws(() => validPort("banana"), BridgeUsageError);
  assert.throws(() => validPort(0), BridgeUsageError);
  assert.throws(() => validPort(70000), BridgeUsageError);
  assert.throws(() => validPort(7801.5), BridgeUsageError);
});

test("scan ranges expand inclusively and de-duplicate", () => {
  assert.deepEqual(parsePortRange("7777"), [7777]);
  assert.deepEqual(parsePortRange("7800-7803"), [7800, 7801, 7802, 7803]);
  assert.deepEqual(parsePortRange("7777,7800-7802,7777"), [7777, 7800, 7801, 7802]);
  assert.deepEqual(parsePortRange(" 7801 , 7802 "), [7801, 7802]);
});

test("absurd scan ranges are refused rather than hanging the caller", () => {
  assert.throws(() => parsePortRange("1-65535"), BridgeUsageError);
  assert.throws(() => parsePortRange("7810-7800"), BridgeUsageError);
  assert.throws(() => parsePortRange(""), BridgeUsageError);
});

test("CLI accepts both --flag value and --flag=value", () => {
  assert.equal(parseCli(["--port=7809"], {}).config.defaultPort, 7809);
  assert.equal(parseCli(["--port", "7809"], {}).config.defaultPort, 7809);
  assert.equal(parseCli(["-p", "7809"], {}).config.defaultPort, 7809);
});

test("CLI reports help and version without starting anything", () => {
  assert.equal(parseCli(["--help"], {}).action, "help");
  assert.equal(parseCli(["-h"], {}).action, "help");
  assert.equal(parseCli(["--version"], {}).action, "version");
  assert.equal(parseCli([], {}).action, "run");
});

test("CLI rejects unknown options instead of silently ignoring them", () => {
  assert.throws(() => parseCli(["--prot", "7801"], {}), BridgeUsageError);
  assert.throws(() => parseCli(["--port"], {}), BridgeUsageError);
});

test("scan range and launch hint come from flags or environment", () => {
  const { config } = parseCli(["--scan-range", "7800-7802", "--launch-hint", "make run PORT={port}"], {});
  assert.deepEqual(config.scanPorts, [7800, 7801, 7802]);
  assert.match(config.launchHint, /make run PORT=\{port\}/);

  const fromEnv = parseCli([], {
    GAME_BRIDGE_SCAN_RANGE: "7900-7901",
    GAME_BRIDGE_LAUNCH_HINT: "env-hint {port}",
  }).config;
  assert.deepEqual(fromEnv.scanPorts, [7900, 7901]);
  assert.equal(fromEnv.launchHint, "env-hint {port}");
});
