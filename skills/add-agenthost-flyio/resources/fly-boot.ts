import { registerRuntimeDriver } from "./agenthosts.js";
import { readEnvFile } from "./env.js";
import { log } from "./log.js";
import { applyFlyHostEnvFromFile } from "./fly-env.js";
import {
  FLY_RUNTIME_NAME,
  cleanupFlyOrphans,
  flyDriver,
  isFlyRuntimeAllowed,
} from "./fly-runtime.js";

/**
 * Apply .env Fly host keys into process.env when unset
 * (NanoClaw does not dotenv-load; LaunchAgents often omit these keys).
 */
function applyFlyHostEnv(): void {
  applyFlyHostEnvFromFile(process.env, (keys) => readEnvFile(keys));
}

/**
 * Register the Fly Machines RuntimeDriver with nanoclaw-agenthosts.
 * Idempotent — safe to call on every host boot.
 *
 * Wakes still require `NANOCLAW_ALLOW_FLY_RUNTIME=1` so a per-group
 * `--runtime fly` flag alone cannot start remote Machines.
 *
 * Also rehydrates live Machines after register: index orphan cleanup runs
 * before skill modules load, so Fly would otherwise miss boot rehydrate
 * and outbound would fall back to the 60s sweep (~10–60s chat lag).
 */
export function startAgenthostFlyio(): void {
  applyFlyHostEnv();
  registerRuntimeDriver(FLY_RUNTIME_NAME, flyDriver);
  if (!isFlyRuntimeAllowed()) {
    log.warn(
      "Registered RuntimeDriver: fly — wakes fail closed until NANOCLAW_ALLOW_FLY_RUNTIME=1 (set in host env or .env)",
    );
    return;
  }
  log.info("Registered RuntimeDriver: fly");
  void cleanupFlyOrphans().catch((error) => {
    log.warn("fly boot rehydrate failed", { error });
  });
}
