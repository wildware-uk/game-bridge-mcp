/**
 * Programmatic entry point.
 *
 * The bridge is published as a CLI, but the pieces are exported too, and that
 * is the intended way for a game's own repository to use it: register the
 * composites that only make sense for that game, hand them to `createServer`,
 * and inherit the protocol, the launcher, discovery and the failure messages
 * rather than maintaining a second copy of them.
 */
export { Bridge, summarise, type InstanceReport, type BridgeOptions } from "./bridge.js";
export { GameClient, type FetchLike, type GameState, type SyncResult } from "./client.js";
export {
  BUILTIN_COMPOSITES,
  compositeApplies,
  type Composite,
  type CompositeContext,
} from "./composites.js";
export {
  parseCli,
  parsePortRange,
  resolvePort,
  validPort,
  formatLaunchHint,
  DEFAULT_PORT,
  DEFAULT_SCAN_RANGE,
  DEFAULT_LAUNCH_HINT,
  type BridgeConfig,
} from "./config.js";
export {
  BridgeUsageError,
  CommandTimeout,
  GameOffline,
  HttpStatusError,
  NotAGameSurface,
} from "./errors.js";
export {
  Launcher,
  findProjectConfig,
  applyProjectConfig,
  ephemeralPort,
  portIsFree,
  DEFAULT_LAUNCH_RANGE,
  CONFIG_FILENAMES,
  type LaunchSpec,
  type ProjectConfig,
  type LaunchedInstance,
} from "./launcher.js";
export {
  bridgeToolset,
  fallbackManifest,
  normaliseManifest,
  toInputSchema,
  toolIndex,
  SUPPORTED_PROTOCOL,
  type Manifest,
  type ToolDef,
  type ToolsetDef,
  type ArgDef,
} from "./manifest.js";
export {
  readRegistry,
  registryDir,
  pruneEntry,
  DEFAULT_REGISTRY_SUBDIR,
  type RegistryEntry,
} from "./registry.js";
export { createServer, startStdioServer, META_TOOLS, SERVER_NAME, SERVER_VERSION } from "./server.js";
