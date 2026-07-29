/**
 * Fly Machines RuntimeDriver for nanoclaw-agenthosts.
 *
 * Requires sessionio HTTP transport. Persists machine/volume identity in
 * `.fly-machine.json` under the session directory.
 */
import fs from "node:fs";
import path from "node:path";

import type { RuntimeDriver, SessionRef, WakeContext } from "./agenthosts.js";
import { DATA_DIR } from "./config.js";
import { getAgentGroup } from "./db/agent-groups.js";
import { log } from "./log.js";
import {
  clearFlyIdentity,
  readFlyIdentity,
  writeFlyIdentity,
  type FlyMachineIdentity,
} from "./fly-identity.js";
import {
  createFlyMachinesClientFromEnv,
  type FlyMachinesClient,
} from "./fly-machines.js";
import { applyFlyOneCli } from "./fly-onecli.js";
import {
  FLY_REQUIRED_TRANSPORT,
  FLY_RUNTIME_DIRNAME,
  FLY_RUNTIME_NAME,
  FLY_WAKE_BLOCKED_FILENAME,
  WAKE_FAIL_BLOCK_AFTER,
  isFlyRuntimeAllowed,
} from "./fly-shared.js";
import {
  assertHttpTransportForFly,
  buildFlySessionioEnv,
  resolveFlySessionioBaseUrl,
  waitForSessionioHealth,
} from "./fly-transport.js";
import {
  markContainerRunning,
  markContainerStopped,
  sessionDir as hostSessionDir,
} from "./session-manager.js";

export { isFlyRuntimeAllowed, FLY_RUNTIME_NAME, FLY_REQUIRED_TRANSPORT };
export { clearFlyIdentity, readFlyIdentity, writeFlyIdentity };
export type { FlyMachineIdentity };

export interface FlyWakeDeps {
  createClient?: (env?: NodeJS.ProcessEnv) => FlyMachinesClient;
  applyOneCli?: typeof applyFlyOneCli;
  waitHealth?: typeof waitForSessionioHealth;
  resolveSessionDir?: (session: SessionRef) => string;
  resolveGroupFolder?: (agentGroupId: string) => string;
}

interface TrackedMachine {
  machineId: string;
  sessionDir: string;
  markStopped?: () => void;
  killing?: boolean;
}

const activeMachines = new Map<string, TrackedMachine>();
const wakeFailures = new Map<string, number>();
let wakeDeps: FlyWakeDeps = {};

export function setFlyWakeDeps(deps: FlyWakeDeps): void {
  wakeDeps = deps;
}

export function resetFlyDriverStateForTests(): void {
  activeMachines.clear();
  wakeFailures.clear();
  wakeDeps = {};
}

function getClient(env: NodeJS.ProcessEnv = process.env): FlyMachinesClient {
  return (wakeDeps.createClient ?? createFlyMachinesClientFromEnv)(env);
}

function resolveSessionDirectory(session: SessionRef): string {
  if (wakeDeps.resolveSessionDir) return wakeDeps.resolveSessionDir(session);
  return hostSessionDir(session.agent_group_id, session.id);
}

function resolveGroupFolder(agentGroupId: string): string {
  if (wakeDeps.resolveGroupFolder) {
    return wakeDeps.resolveGroupFolder(agentGroupId);
  }
  const group = getAgentGroup(agentGroupId);
  return group?.folder ?? agentGroupId;
}

function machineNameFor(session: SessionRef): string {
  const safe = `${session.agent_group_id}-${session.id}`
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 50);
  return `ncl-${safe}`.slice(0, 63);
}

function volumeNameFor(session: SessionRef): string {
  return `vol-${machineNameFor(session)}`.slice(0, 63);
}

function recordWakeFailure(sessionId: string, sessionDirectory: string): void {
  const count = (wakeFailures.get(sessionId) ?? 0) + 1;
  wakeFailures.set(sessionId, count);
  if (count >= WAKE_FAIL_BLOCK_AFTER) {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME),
      `Blocked after ${count} consecutive wake failures\n`,
      { mode: 0o600 },
    );
  }
}

function clearWakeFailure(sessionId: string, sessionDirectory: string): void {
  wakeFailures.delete(sessionId);
  const blocked = path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME);
  if (fs.existsSync(blocked)) fs.unlinkSync(blocked);
}

function requireFlyConfig(env: NodeJS.ProcessEnv): {
  image: string;
  region: string;
  volumeSizeGb: number;
  gatewayHost: string;
} {
  const image = (env.FLY_AGENT_IMAGE ?? "").trim();
  if (!image) throw new Error("FLY_AGENT_IMAGE is required for fly runtime");
  /* v8 ignore next 3 — whitespace / NaN volume defaults */
  const region = (env.FLY_REGION ?? "iad").trim() || "iad";
  const volumeSizeGb = Math.max(
    1,
    Number.parseInt(env.FLY_VOLUME_SIZE_GB ?? "3", 10) || 3,
  );
  let gatewayHost = "127.0.0.1";
  const gateway = (
    env.GATEWAY_BASE_URL ??
    env.ONECLI_GATEWAY_HOST ??
    ""
  ).trim();
  if (gateway) {
    try {
      gatewayHost = new URL(
        gateway.includes("://") ? gateway : `http://${gateway}`,
      ).hostname;
    } catch {
      gatewayHost = gateway;
    }
  }
  return { image, region, volumeSizeGb, gatewayHost };
}

async function ensureIdentityAndStart(
  session: SessionRef,
  sessionDirectory: string,
  env: NodeJS.ProcessEnv,
): Promise<FlyMachineIdentity> {
  const client = getClient(env);
  const { image, region, volumeSizeGb, gatewayHost } = requireFlyConfig(env);
  /* v8 ignore next 2 — defaults only used when tests omit injectable deps */
  const applyOneCli = wakeDeps.applyOneCli ?? applyFlyOneCli;
  const waitHealth = wakeDeps.waitHealth ?? waitForSessionioHealth;

  const sessionioBase = resolveFlySessionioBaseUrl(env);
  await waitHealth({
    baseUrl: sessionioBase,
    token: env.SESSIONIO_HTTP_TOKEN,
  });

  const onecli = await applyOneCli({
    agentIdentifier: session.agent_group_id,
    agentName: resolveGroupFolder(session.agent_group_id),
    gatewayHost,
  });
  if (!onecli.ok) {
    throw new Error("OneCLI container-config unavailable — fail closed");
  }

  const sessionioEnv = buildFlySessionioEnv(session, env);
  const machineEnv = {
    ...onecli.env,
    ...sessionioEnv,
    GROUPS_DIR: "/workspace/groups",
    NANOCLAW_GROUP_FOLDER: resolveGroupFolder(session.agent_group_id),
  };

  let identity = readFlyIdentity(sessionDirectory);
  if (!identity) {
    const volume = await client.createVolume({
      name: volumeNameFor(session),
      region,
      sizeGb: volumeSizeGb,
    });
    const machine = await client.createMachine({
      name: machineNameFor(session),
      region,
      image,
      env: machineEnv,
      volumeId: volume.id,
      volumeMountPath: "/workspace",
      files: onecli.files,
    });
    identity = {
      machineId: machine.id,
      volumeId: volume.id,
      app: client.app,
      region,
      image,
    };
    writeFlyIdentity(sessionDirectory, identity);
  } else {
    await client.updateMachineEnv(identity.machineId, {
      image: identity.image,
      env: machineEnv,
      auto_destroy: false,
      restart: { policy: "no" },
      mounts: [{ volume: identity.volumeId, path: "/workspace" }],
      files: onecli.files.map((f) => ({
        guest_path: f.guestPath,
        raw_value: Buffer.from(f.rawValue, "utf8").toString("base64"),
      })),
      services: [],
    });
  }

  fs.mkdirSync(path.join(sessionDirectory, FLY_RUNTIME_DIRNAME), {
    recursive: true,
  });
  await client.startMachine(identity.machineId);
  await client.waitMachine(identity.machineId, "started", 120);
  return identity;
}

export async function wakeFly(
  session: SessionRef,
  ctx: WakeContext = {},
): Promise<boolean> {
  const env = process.env;
  if (!isFlyRuntimeAllowed(env)) {
    log.warn(
      `fly wake refused for ${session.id}: NANOCLAW_ALLOW_FLY_RUNTIME not set`,
    );
    return false;
  }

  const sessionDirectory = resolveSessionDirectory(session);
  if (fs.existsSync(path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME))) {
    log.warn(
      `fly wake blocked for ${session.id}: see ${FLY_WAKE_BLOCKED_FILENAME}`,
    );
    return false;
  }

  const existing = activeMachines.get(session.id);
  if (existing && !existing.killing) {
    return true;
  }

  try {
    const transportHint =
      (typeof ctx.transportName === "string" && ctx.transportName) ||
      (env.SESSIONIO_TRANSPORT ?? "").trim() ||
      "http";
    assertHttpTransportForFly(transportHint);

    const identity = await ensureIdentityAndStart(
      session,
      sessionDirectory,
      env,
    );

    const markStopped = () => markContainerStopped(session.id);
    markContainerRunning(session.id);
    activeMachines.set(session.id, {
      machineId: identity.machineId,
      sessionDir: sessionDirectory,
      markStopped,
    });
    clearWakeFailure(session.id, sessionDirectory);
    log.info(
      `fly wake started machine ${identity.machineId} for ${session.id}`,
    );
    return true;
  } catch (error) {
    log.error(
      `fly wake failed for ${session.id}: ${
        /* v8 ignore next */
        error instanceof Error ? error.message : String(error)
      }`,
    );
    recordWakeFailure(session.id, sessionDirectory);
    return false;
  }
}

export function killFly(
  sessionId: string,
  reason: string,
  onExit?: () => void,
): void {
  void reason;
  const tracked = activeMachines.get(sessionId);
  if (tracked) tracked.killing = true;

  const run = async (): Promise<void> => {
    try {
      if (!tracked?.machineId) {
        markContainerStopped(sessionId);
        return;
      }
      const client = getClient(process.env);
      await client.stopMachine(tracked.machineId);
      tracked.markStopped?.();
      activeMachines.delete(sessionId);
      markContainerStopped(sessionId);
    } catch (error) {
      log.warn(
        `fly kill failed for ${sessionId}: ${
          /* v8 ignore next */
          error instanceof Error ? error.message : String(error)
        }`,
      );
      activeMachines.delete(sessionId);
      markContainerStopped(sessionId);
    } finally {
      onExit?.();
    }
  };

  void run();
}

export function isFlyRunning(sessionId: string): boolean {
  const tracked = activeMachines.get(sessionId);
  return Boolean(tracked && !tracked.killing);
}

export async function cleanupFlyOrphans(): Promise<void> {
  const sessionsRoot = path.join(DATA_DIR, "v2-sessions");
  if (!fs.existsSync(sessionsRoot)) return;

  let client: FlyMachinesClient;
  try {
    client = getClient(process.env);
  } catch {
    return;
  }

  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, group.name);
    for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const sessionId = session.name;
      if (activeMachines.has(sessionId)) continue;
      const dir = path.join(groupDir, sessionId);
      const identity = readFlyIdentity(dir);
      if (!identity) continue;
      try {
        const machine = await client.getMachine(identity.machineId);
        if (machine.state === "started" || machine.state === "starting") {
          log.warn(
            `fly orphan cleanup stopping machine ${identity.machineId} for ${sessionId}`,
          );
          await client.stopMachine(identity.machineId);
        }
      } catch (error) {
        log.warn(
          `fly orphan skip ${sessionId}: ${
            /* v8 ignore next */
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
  }
}

export const flyDriver: RuntimeDriver = {
  wake: wakeFly,
  kill: killFly,
  isRunning: isFlyRunning,
  cleanupOrphans: cleanupFlyOrphans,
  requiredTransport: FLY_REQUIRED_TRANSPORT,
};
