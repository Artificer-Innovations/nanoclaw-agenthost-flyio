/**
 * Fly Machines RuntimeDriver for nanoclaw-agenthosts.
 *
 * Requires sessionio HTTP transport. Persists machine/volume identity in
 * `.fly-machine.json` under the session directory.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { RuntimeDriver, SessionRef, WakeContext } from "./agenthosts.js";
import { DATA_DIR, GROUPS_DIR } from "./config.js";
import { getAgentGroup } from "./db/agent-groups.js";
import { readEnvFile } from "./env.js";
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
import { applyFlyOneCli, type FlyGuestFile } from "./fly-onecli.js";
import {
  FLY_REQUIRED_TRANSPORT,
  FLY_RUNTIME_DIRNAME,
  FLY_RUNTIME_NAME,
  FLY_WAKE_BLOCKED_FILENAME,
  WAKE_BLOCKED_TTL_MS,
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
  /** Hosthook container env (agenttrace, etc.). Defaults to runContainerEnvContributors when available. */
  containerEnv?: (occupiedKeys: string[]) => Record<string, string>;
  /**
   * Optional runtime status publisher (tests / hosts without agenthosts onStatus).
   * Prefer ctx.onStatus from agenthosts when present.
   */
  publishRuntimeActivity?: (
    session: SessionRef,
    input: { phase: string; summary: string; state?: string },
  ) => void | Promise<void>;
}

function emitFlyStatus(
  session: SessionRef,
  ctx: WakeContext,
  phase: string,
  summary: string,
  state?: "started" | "progress" | "succeeded" | "failed",
): void {
  try {
    if (typeof ctx.onStatus === "function") {
      ctx.onStatus(phase, summary, state ? { state } : undefined);
      return;
    }
    const publish = wakeDeps.publishRuntimeActivity;
    if (typeof publish === "function") {
      void Promise.resolve(publish(session, { phase, summary, state })).catch(
        () => {
          /* never fail wake on status */
        },
      );
    }
  } catch {
    /* never fail wake on status */
  }
}

interface TrackedMachine {
  machineId: string;
  sessionDir: string;
  markStopped?: () => void;
  killing?: boolean;
}

const activeMachines = new Map<string, TrackedMachine>();
const wakeFailures = new Map<string, number>();
/** Coalesce concurrent wakeFly calls for the same session. */
const wakeInflight = new Map<string, Promise<boolean>>();
let wakeDeps: FlyWakeDeps = {};

export function setFlyWakeDeps(deps: FlyWakeDeps): void {
  wakeDeps = deps;
}

export function resetFlyDriverStateForTests(): void {
  activeMachines.clear();
  wakeFailures.clear();
  wakeInflight.clear();
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

/**
 * Fly machine names max out at 63 chars. Truncating `ag-…-sess-…` collides
 * when two session ids share a long common prefix (e.g. same millis epoch).
 * Hash the full ids like volumes do.
 */
function machineNameFor(session: SessionRef): string {
  const digest = createHash("sha256")
    .update(`${session.agent_group_id}\0${session.id}`)
    .digest("hex")
    .slice(0, 40);
  return `ncl-${digest}`;
}

/**
 * Fly volume names allow only `[a-z0-9_]` and at most 30 characters.
 * Session ids contain hyphens and are far longer, so hash them.
 */
function volumeNameFor(session: SessionRef): string {
  const digest = createHash("sha256")
    .update(`${session.agent_group_id}\0${session.id}`)
    .digest("hex")
    .slice(0, 26);
  return `v_${digest}`;
}

/**
 * Stage group config outside the volume mount path.
 * Fly writes guest files before mounting `/workspace`, so paths under
 * `/workspace/...` are hidden; `/etc/nanoclaw/agent/` survives and the
 * runner copies onto the volume at boot.
 *
 * Docker bind-mounts the whole group folder (WEBCHAT.md, .webchat/, …).
 * Fly must inject the small discovery/auth files the agent needs for
 * webchat HTTP history + tools — otherwise it has no WEBCHAT.md and an
 * unreachable host.docker.internal apiBase.
 */
function collectGroupGuestFiles(
  groupFolder: string,
  env: NodeJS.ProcessEnv = process.env,
): FlyGuestFile[] {
  const files: FlyGuestFile[] = [];
  const groupDir = path.join(GROUPS_DIR, groupFolder);
  const textNames = [
    "container.json",
    "CLAUDE.md",
    "WEBCHAT.md",
    "AGENTS.md",
    "webchat-profile.json",
  ] as const;
  for (const name of textNames) {
    const hostPath = path.join(groupDir, name);
    if (!fs.existsSync(hostPath)) continue;
    let rawValue = fs.readFileSync(hostPath, "utf8");
    if (name === "WEBCHAT.md") {
      rawValue = rewriteWebchatMdForFly(rawValue, env);
    }
    files.push({
      guestPath: `/etc/nanoclaw/agent/${name}`,
      rawValue,
    });
  }

  const credPath = path.join(groupDir, ".webchat", "credentials.json");
  if (fs.existsSync(credPath)) {
    files.push({
      guestPath: "/etc/nanoclaw/agent/.webchat/credentials.json",
      rawValue: buildFlyWebchatCredentialsJson(credPath, env),
    });
  }
  return files;
}

/** Keys consulted for a Fly-reachable webchat apiBase (not dumped into process.env). */
export const FLY_WEBCHAT_API_BASE_KEYS = [
  "WEBCHAT_FLY_API_BASE",
  "WEBCHAT_PUBLIC_BASE_URL",
  "WEBCHAT_CONTAINER_API_BASE",
] as const;

/**
 * Prefer a host Fly Machines can reach (public ngrok), not host.docker.internal.
 *
 * Reads only the webchat URL keys from `.env` via `readEnvFile` when unset in
 * `env` — NanoClaw does not dotenv-load, and LaunchAgents often omit these.
 * Values stay out of process.env so child processes do not inherit them.
 */
export function resolveFlyWebchatApiBase(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (keys: string[]) => Record<string, string> = readEnvFile,
): string | null {
  const fromFile = readFile([...FLY_WEBCHAT_API_BASE_KEYS]);
  for (const key of FLY_WEBCHAT_API_BASE_KEYS) {
    const raw = (env[key] ?? fromFile[key] ?? "").trim();
    if (!raw) continue;
    try {
      const url = new URL(raw.includes("://") ? raw : `http://${raw}`);
      // Docker-only hostnames are unreachable from Fly.
      if (
        url.hostname === "host.docker.internal" ||
        url.hostname === "localhost" ||
        url.hostname === "127.0.0.1"
      ) {
        continue;
      }
      return `${url.protocol}//${url.host}`.replace(/\/$/, "");
    } catch {
      continue;
    }
  }
  return null;
}

function buildFlyWebchatCredentialsJson(
  hostCredPath: string,
  env: NodeJS.ProcessEnv,
): string {
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(fs.readFileSync(hostCredPath, "utf8")) as Record<
      string,
      unknown
    >;
  } catch {
    parsed = {};
  }
  const apiBase = resolveFlyWebchatApiBase(env);
  if (apiBase) parsed.apiBase = apiBase;
  return `${JSON.stringify(parsed, null, 2)}\n`;
}

function rewriteWebchatMdForFly(body: string, env: NodeJS.ProcessEnv): string {
  const apiBase = resolveFlyWebchatApiBase(env);
  let next = body;
  if (apiBase) {
    next = next
      .replace(
        /Configured apiBase:\s*`[^`]+`/g,
        `Configured apiBase: \`${apiBase}\``,
      )
      .replace(/http:\/\/host\.docker\.internal:\d+/g, apiBase);
  }
  if (!next.includes("## Fly / remote runtime")) {
    next += `

## Fly / remote runtime

Claude transcript resume can reset across Machine restarts. When you lack recent chat context, call \`webchat_read_channel\` / \`webchat_read_thread\` (or \`GET /api/agent/tools\` then those tools) with your bearer token to load history — including messages from every member of the room — instead of guessing.

**Attachments work from Fly.** Call \`mcp__nanoclaw__send_file({ to, path })\` with an explicit destination (the inbound \`from=\` name, e.g. \`channel-6\`). NanoClaw stages file bytes to the host over sessionio — you do **not** need a shared filesystem with webchat, and peers who say otherwise are describing a different (external MCP) path. Writing a file without \`send_file\` never attaches anything. If \`send_file\` errors, surface the error; do not conclude attachments are impossible.
`;
  }
  return next;
}

function toMachineFiles(files: FlyGuestFile[]): Array<{
  guest_path: string;
  raw_value: string;
}> {
  return files.map((f) => ({
    guest_path: f.guestPath,
    raw_value: Buffer.from(f.rawValue, "utf8").toString("base64"),
  }));
}

/** True when Fly reports the Machine is missing (dashboard destroy / wrong app). */
export function isMachineGoneError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // Do not treat volume/image misses as machine-gone — those are persistent
  // misconfigs that should still write `.fly.wake-blocked`.
  if (/\bvolume\b|\bimage\b/i.test(msg) && !/\bmachines?\//i.test(msg)) {
    return false;
  }
  const missing = /\b(404|not found|does not exist)\b/i.test(msg);
  return (
    (/\bmachines\/[^/\s?]+\b/i.test(msg) && missing) ||
    /\b(no machine|machine not found)\b/i.test(msg) ||
    (/\bmachine\b/i.test(msg) && /\bdoes not exist\b/i.test(msg))
  );
}

/**
 * Transient infra / transport failures should not write `.fly.wake-blocked`.
 * Clickops (stop/destroy) and tunnel blips are expected to self-heal on retry.
 */
export function isRetryableWakeError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  return (
    /sessionio|not ready|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|network|fetch failed|AbortError|timeout|429|502|503|504|ngrok|getting replaced|unable to start machine from current state/i.test(
      msg,
    ) || isMachineGoneError(error)
  );
}

function recordWakeFailure(
  sessionId: string,
  sessionDirectory: string,
  error: unknown,
): void {
  if (isRetryableWakeError(error)) {
    log.warn(
      `fly wake failure for ${sessionId} is retryable — not writing ${FLY_WAKE_BLOCKED_FILENAME}`,
      { err: error instanceof Error ? error.message : String(error) },
    );
    return;
  }
  const count = (wakeFailures.get(sessionId) ?? 0) + 1;
  wakeFailures.set(sessionId, count);
  if (count >= WAKE_FAIL_BLOCK_AFTER) {
    fs.mkdirSync(sessionDirectory, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME),
      `Blocked after ${count} consecutive wake failures\nblockedAt=${new Date().toISOString()}\n`,
      { mode: 0o600 },
    );
  }
}

function clearWakeFailure(sessionId: string, sessionDirectory: string): void {
  wakeFailures.delete(sessionId);
  const blocked = path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME);
  if (fs.existsSync(blocked)) fs.unlinkSync(blocked);
}

/** Return false when the block file is absent or older than WAKE_BLOCKED_TTL_MS. */
function isWakeBlocked(
  sessionId: string,
  sessionDirectory: string,
  nowMs: number = Date.now(),
): boolean {
  const blocked = path.join(sessionDirectory, FLY_WAKE_BLOCKED_FILENAME);
  if (!fs.existsSync(blocked)) return false;
  try {
    const age = nowMs - fs.statSync(blocked).mtimeMs;
    if (age >= WAKE_BLOCKED_TTL_MS) {
      log.info(
        `fly wake-blocked expired for ${sessionId} after ${Math.round(age / 1000)}s — clearing`,
      );
      clearWakeFailure(sessionId, sessionDirectory);
      return false;
    }
  } catch {
    clearWakeFailure(sessionId, sessionDirectory);
    return false;
  }
  return true;
}

/**
 * Dashboard stop/destroy can leave activeMachines lying.
 * Returns "live" when Fly still shows started/starting; "stale" after dropping the map entry.
 * Transient probe errors trust the map (avoid flapping on API blips).
 */
async function reconcileTrackedMachine(
  sessionId: string,
  tracked: TrackedMachine,
): Promise<"live" | "stale"> {
  try {
    const client = getClient(process.env);
    const remote = await client.getMachine(tracked.machineId);
    const state = (remote.state ?? "").toLowerCase();
    if (state === "started" || state === "starting") return "live";
    log.info(
      `fly tracked machine ${tracked.machineId} for ${sessionId} is ${state || "unknown"} — will re-wake`,
    );
    activeMachines.delete(sessionId);
    markContainerStopped(sessionId);
    return "stale";
  } catch (error) {
    if (isMachineGoneError(error)) {
      log.info(
        `fly tracked machine ${tracked.machineId} for ${sessionId} is gone — will re-wake`,
      );
      activeMachines.delete(sessionId);
      markContainerStopped(sessionId);
      return "stale";
    }
    log.warn(
      `fly reconcile getMachine ${tracked.machineId} failed — trusting in-memory running: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return "live";
  }
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
  // Pass through full GATEWAY_BASE_URL when set so proxy rewrite can drop
  // Docker's :10255 and use the public authority (e.g. ngrok host on 443/80).
  const gateway = (
    env.GATEWAY_BASE_URL ??
    env.ONECLI_GATEWAY_HOST ??
    ""
  ).trim();
  const gatewayHost = gateway || "127.0.0.1";
  return { image, region, volumeSizeGb, gatewayHost };
}

async function ensureIdentityAndStart(
  session: SessionRef,
  sessionDirectory: string,
  env: NodeJS.ProcessEnv,
  ctx: WakeContext,
): Promise<FlyMachineIdentity> {
  const client = getClient(env);
  const { image, region, volumeSizeGb, gatewayHost } = requireFlyConfig(env);
  /* v8 ignore next 2 — defaults only used when tests omit injectable deps */
  const applyOneCli = wakeDeps.applyOneCli ?? applyFlyOneCli;
  const waitHealth = wakeDeps.waitHealth ?? waitForSessionioHealth;

  emitFlyStatus(
    session,
    ctx,
    "waiting_transport",
    "Waiting for session transport…",
  );
  const sessionioBase = resolveFlySessionioBaseUrl(env);
  await waitHealth({
    baseUrl: sessionioBase,
    token: env.SESSIONIO_HTTP_TOKEN,
  });

  emitFlyStatus(session, ctx, "configuring", "Preparing credentials…");
  const onecli = await applyOneCli({
    agentIdentifier: session.agent_group_id,
    agentName: resolveGroupFolder(session.agent_group_id),
    gatewayHost,
  });
  if (!onecli.ok) {
    throw new Error("OneCLI container-config unavailable — fail closed");
  }

  const groupFolder = resolveGroupFolder(session.agent_group_id);
  const sessionioEnv = buildFlySessionioEnv(session, env);
  const baseEnv: Record<string, string> = {
    ...onecli.env,
    ...sessionioEnv,
    GROUPS_DIR: "/workspace/groups",
    NANOCLAW_GROUP_FOLDER: groupFolder,
  };
  // Docker/process get hosthook env (AGENTTRACE_*, …) via container-runner.
  // Fly must merge the same contributors or observe stays fail-closed in-guest.
  let hosthookEnv: Record<string, string> = {};
  if (wakeDeps.containerEnv) {
    hosthookEnv = wakeDeps.containerEnv(Object.keys(baseEnv));
  } else {
    try {
      const mod = await import("./hosthooks.js");
      if (typeof mod.runContainerEnvContributors === "function") {
        hosthookEnv = mod.runContainerEnvContributors(Object.keys(baseEnv));
      }
      /* v8 ignore next 3 — missing hosthooks module on bare package installs */
    } catch {
      // leave empty
    }
  }
  const machineEnv = {
    ...baseEnv,
    ...hosthookEnv,
    // Docker mounts host `.claude-shared` at /home/node/.claude. Fly only
    // persists /workspace — keep Claude transcripts/config on the volume so
    // resume survives Machine restarts (model changes, env updates, etc.).
    CLAUDE_CONFIG_DIR: "/workspace/.claude",
  };
  const guestFiles = [
    ...onecli.files,
    ...collectGroupGuestFiles(groupFolder, env),
  ];
  const guest = {
    cpus: 1,
    cpu_kind: "shared",
    memory_mb: 1024,
  };

  let identity = readFlyIdentity(sessionDirectory);

  // Prefer current FLY_AGENT_IMAGE so rebuilds take effect on next wake.
  let prevImage = identity?.image;
  if (identity) {
    identity = { ...identity, image };
    writeFlyIdentity(sessionDirectory, identity);
  }

  // Single getMachine probe: drive config update, or clear identity on clickops destroy.
  let machineState: string | undefined;
  let remoteImage: string | undefined;
  let gotRemote = false;
  let remoteEnv: Record<string, string> = {};
  if (identity) {
    const machineId = identity.machineId;
    try {
      const remote = await client.getMachine(machineId);
      const state = (remote.state ?? "").toLowerCase();
      if (state === "destroyed" || state === "destroying") {
        log.warn(
          `fly machine ${machineId} is ${state} — clearing identity for recreate`,
        );
        clearFlyIdentity(sessionDirectory);
        identity = null;
      } else {
        gotRemote = true;
        machineState = remote.state;
        const cfg = remote.config ?? {};
        remoteImage = typeof cfg.image === "string" ? cfg.image : prevImage;
        if (cfg.env && typeof cfg.env === "object") {
          remoteEnv = cfg.env as Record<string, string>;
        }
      }
    } catch (err) {
      if (isMachineGoneError(err)) {
        log.warn(
          `fly machine ${machineId} gone — clearing identity for recreate`,
        );
        clearFlyIdentity(sessionDirectory);
        identity = null;
      } else {
        // Transient probe failure — do NOT update (blind update restarts a
        // healthy Machine and can drop at-most-once HTTP inbound).
        log.warn(
          `fly getMachine ${machineId} failed — skipping config update: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  if (!identity) {
    emitFlyStatus(
      session,
      ctx,
      "provisioning_storage",
      "Provisioning storage…",
    );
    const volume = await client.createVolume({
      name: volumeNameFor(session),
      region,
      sizeGb: volumeSizeGb,
    });
    emitFlyStatus(session, ctx, "allocating", "Creating machine…");
    const machine = await client.createMachine({
      name: machineNameFor(session),
      region,
      image,
      env: machineEnv,
      volumeId: volume.id,
      volumeMountPath: "/workspace",
      files: guestFiles,
      memoryMb: guest.memory_mb,
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
    // Fly applies config updates by restarting the Machine (SIGINT). Doing that
    // on every chat message kills mid-turn work and feels like a cold start.
    // Only POST an update when the Machine is not already running, or the
    // pinned image / hosthook env / Claude persist path changed.
    const running = machineState === "started" || machineState === "starting";
    const imageChanged = Boolean(image) && image !== remoteImage;
    const needsHosthookEnv = Object.entries(hosthookEnv).some(
      ([key, value]) => remoteEnv[key] !== value,
    );
    const needsClaudePersist =
      remoteEnv.CLAUDE_CONFIG_DIR !== machineEnv.CLAUDE_CONFIG_DIR;
    if (
      gotRemote &&
      (!running || imageChanged || needsHosthookEnv || needsClaudePersist)
    ) {
      emitFlyStatus(
        session,
        ctx,
        "updating_config",
        "Updating machine config…",
      );
      await client.updateMachineEnv(identity.machineId, {
        image,
        env: machineEnv,
        auto_destroy: false,
        restart: { policy: "no" },
        guest,
        mounts: [{ volume: identity.volumeId, path: "/workspace" }],
        files: toMachineFiles(guestFiles),
        services: [],
      });
    }
  }

  fs.mkdirSync(path.join(sessionDirectory, FLY_RUNTIME_DIRNAME), {
    recursive: true,
  });
  emitFlyStatus(session, ctx, "starting", "Starting machine…");
  await startFlyMachineWhenReady(client, identity.machineId);
  return identity;
}

/** Fly refuses start while a config update is replacing the Machine. */
export async function startFlyMachineWhenReady(
  client: FlyMachinesClient,
  machineId: string,
  opts: { timeoutMs?: number; sleepMs?: number } = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 90_000;
  const sleepMs = opts.sleepMs ?? 1_000;
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const remote = await client.getMachine(machineId);
      const state = remote.state ?? "";
      if (state === "started" || state === "starting") {
        await client.waitMachine(machineId, "started", 60);
        return;
      }
      await client.startMachine(machineId);
      await client.waitMachine(machineId, "started", 60);
      return;
    } catch (error) {
      lastError = error;
      const msg = error instanceof Error ? error.message : String(error);
      if (
        /getting replaced|unable to start machine from current state/i.test(msg)
      ) {
        await new Promise((r) => setTimeout(r, sleepMs));
        continue;
      }
      throw error;
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error(
        `Fly machine ${machineId} not startable within ${timeoutMs}ms after update`,
      );
}

/**
 * If we already track a live Machine, confirm with Fly and return true.
 * Shared by wakeFly (warm path) and doWakeFly (post-race re-check).
 */
async function tryWarmLiveReturn(sessionId: string): Promise<boolean> {
  const existing = activeMachines.get(sessionId);
  if (!existing || existing.killing) return false;
  // Dashboard stop leaves the map lying — verify Fly before trusting it.
  const status = await reconcileTrackedMachine(sessionId, existing);
  if (status !== "live") return false;
  // Keep DB in sync — delivery's 1s poll keys off container_status, and an
  // early return used to leave a stale `stopped` row (60s sweep only).
  markContainerRunning(sessionId);
  return true;
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
    emitFlyStatus(session, ctx, "blocked", "Agent runtime blocked", "failed");
    return false;
  }

  const sessionDirectory = resolveSessionDirectory(session);
  if (isWakeBlocked(session.id, sessionDirectory)) {
    log.warn(
      `fly wake blocked for ${session.id}: see ${FLY_WAKE_BLOCKED_FILENAME}`,
    );
    emitFlyStatus(session, ctx, "blocked", "Agent runtime blocked", "failed");
    return false;
  }

  if (await tryWarmLiveReturn(session.id)) return true;

  const inflight = wakeInflight.get(session.id);
  if (inflight) return inflight;

  const run = doWakeFly(session, sessionDirectory, ctx, env).finally(() => {
    wakeInflight.delete(session.id);
  });
  wakeInflight.set(session.id, run);
  return run;
}

async function doWakeFly(
  session: SessionRef,
  sessionDirectory: string,
  ctx: WakeContext,
  env: NodeJS.ProcessEnv,
): Promise<boolean> {
  // Re-check after a raced peer wake populated activeMachines.
  /* v8 ignore next -- narrow race with concurrent doWakeFly; warm path covered via wakeFly */
  if (await tryWarmLiveReturn(session.id)) return true;

  try {
    emitFlyStatus(session, ctx, "preparing", "Waking agent…");
    const transportHint =
      (typeof ctx.transportName === "string" && ctx.transportName.trim()) ||
      (env.SESSIONIO_TRANSPORT ?? "").trim();
    // Fail closed: never assume http. Misconfigured hosts must not wake Fly
    // against a filesystem mailbox (or an unset transport).
    if (!transportHint) {
      throw new Error(
        "fly runtime requires SESSIONIO_TRANSPORT=http (or ctx.transportName)",
      );
    }
    assertHttpTransportForFly(transportHint);

    const identity = await ensureIdentityAndStart(
      session,
      sessionDirectory,
      env,
      ctx,
    );

    const markStopped = () => markContainerStopped(session.id);
    markContainerRunning(session.id);
    activeMachines.set(session.id, {
      machineId: identity.machineId,
      sessionDir: sessionDirectory,
      markStopped,
    });
    clearWakeFailure(session.id, sessionDirectory);
    emitFlyStatus(session, ctx, "ready", "Agent runtime ready…", "succeeded");
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
    emitFlyStatus(
      session,
      ctx,
      "failed",
      "Couldn't start agent runtime",
      "failed",
    );
    recordWakeFailure(session.id, sessionDirectory, error);
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

  // Drop map entries for Machines stopped/destroyed outside NanoClaw (dashboard).
  for (const [sessionId, tracked] of [...activeMachines.entries()]) {
    if (tracked.killing) continue;
    await reconcileTrackedMachine(sessionId, tracked);
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
          // Host restart clears the in-memory map — re-adopt the live Machine
          // instead of stopping it (that caused cold starts + delivery lag).
          const markStopped = () => markContainerStopped(sessionId);
          markContainerRunning(sessionId);
          activeMachines.set(sessionId, {
            machineId: identity.machineId,
            sessionDir: dir,
            markStopped,
          });
          log.info(
            `fly rehydrated machine ${identity.machineId} for ${sessionId}`,
          );
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
