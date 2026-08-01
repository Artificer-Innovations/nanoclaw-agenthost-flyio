/**
 * Shared constants / types for nanoclaw-agenthost-flyio.
 * Synced into packages/host/src/fly-shared.ts for NanoClaw fork copies.
 */

export const FLY_RUNTIME_NAME = "fly" as const;
export const FLY_REQUIRED_TRANSPORT = "http" as const;
export const FLY_IDENTITY_FILENAME = ".fly-machine.json";
export const FLY_RUNTIME_DIRNAME = ".fly-runtime";
export const FLY_WAKE_BLOCKED_FILENAME = ".fly.wake-blocked";
export const WAKE_FAIL_BLOCK_AFTER = 5;
/** Auto-clear `.fly.wake-blocked` after this age so clickops / tunnel blips self-heal. */
export const WAKE_BLOCKED_TTL_MS = 15 * 60 * 1000;

/** Default Machines API base (Fly Machines HTTP API). */
export const FLY_MACHINES_API_BASE = "https://api.machines.dev/v1";

export const FLY_HOST_ENV_KEYS = [
  "NANOCLAW_ALLOW_FLY_RUNTIME",
  "FLY_API_TOKEN",
  "FLY_APP_AGENTS",
  "FLY_AGENT_IMAGE",
  "FLY_REGION",
  "FLY_MACHINES_API_BASE",
  "FLY_VOLUME_SIZE_GB",
  "FLY_SESSIONIO_BASE_URL",
  "GATEWAY_BASE_URL",
  "ONECLI_GATEWAY_HOST",
] as const;

export type FlyHostEnvKey = (typeof FLY_HOST_ENV_KEYS)[number];

export interface FlyMachineIdentity {
  machineId: string;
  volumeId: string;
  app: string;
  region: string;
  image: string;
  /** ISO timestamp of last successful identity write. */
  updatedAt?: string;
}

export function isFlyRuntimeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const raw = (env.NANOCLAW_ALLOW_FLY_RUNTIME ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}
