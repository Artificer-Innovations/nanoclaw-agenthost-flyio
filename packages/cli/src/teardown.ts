/**
 * Destroy Fly Machines + volumes for every session identity under the fork.
 * Idle kill only stops; this is what stops billing. Called from `teardown`
 * and from `uninstall` (best-effort).
 */
import fs from "node:fs";
import path from "node:path";
import { findNanoclawRoot } from "./paths.js";

const IDENTITY = ".fly-machine.json";
const DEFAULT_API = "https://api.machines.dev/v1";

export interface TeardownSessionResult {
  sessionDir: string;
  machineId?: string;
  volumeId?: string;
  machineDeleted: boolean;
  volumeDeleted: boolean;
  identityCleared: boolean;
  error?: string;
}

export interface TeardownResult {
  root: string;
  app: string;
  sessions: TeardownSessionResult[];
  machinesDeleted: number;
  volumesDeleted: number;
  errors: number;
}

function readEnvFile(root: string, keys: string[]): Record<string, string> {
  const file = path.join(root, ".env");
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  const want = new Set(keys);
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (!m || !want.has(m[1])) continue;
    let v = m[2].trim();
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function resolveFlyCreds(
  root: string,
  env: NodeJS.ProcessEnv,
): { token: string; app: string; apiBase: string } {
  const fromFile = readEnvFile(root, [
    "FLY_API_TOKEN",
    "FLY_APP_AGENTS",
    "FLY_MACHINES_API_BASE",
  ]);
  const token = (env.FLY_API_TOKEN ?? fromFile.FLY_API_TOKEN ?? "").trim();
  const app = (env.FLY_APP_AGENTS ?? fromFile.FLY_APP_AGENTS ?? "").trim();
  const apiBase = (
    env.FLY_MACHINES_API_BASE ??
    fromFile.FLY_MACHINES_API_BASE ??
    DEFAULT_API
  )
    .trim()
    .replace(/\/$/, "");
  if (!token) throw new Error("FLY_API_TOKEN is required for teardown");
  if (!app) throw new Error("FLY_APP_AGENTS is required for teardown");
  return { token, app, apiBase };
}

async function flyDelete(
  apiBase: string,
  token: string,
  relPath: string,
  fetchImpl: typeof fetch,
): Promise<void> {
  const response = await fetchImpl(`${apiBase}${relPath}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(30_000),
  });
  if (response.status === 404) return;
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`Fly DELETE ${relPath} failed: ${response.status} ${text}`);
  }
}

function listIdentitySessions(sessionsRoot: string): string[] {
  if (!fs.existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, group.name);
    for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(groupDir, session.name);
      if (fs.existsSync(path.join(dir, IDENTITY))) out.push(dir);
    }
  }
  return out;
}

function readIdentity(
  sessionDir: string,
): { machineId: string; volumeId: string } | null {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(sessionDir, IDENTITY), "utf8"),
    ) as { machineId?: string; volumeId?: string };
    if (typeof raw.machineId !== "string" || typeof raw.volumeId !== "string") {
      return null;
    }
    return { machineId: raw.machineId, volumeId: raw.volumeId };
  } catch {
    return null;
  }
}

export async function runTeardown(
  root?: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    fetchImpl?: typeof fetch;
    sessionsRoot?: string;
  } = {},
): Promise<TeardownResult> {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const env = opts.env ?? process.env;
  const { token, app, apiBase } = resolveFlyCreds(nanoclawRoot, env);
  const fetchImpl = opts.fetchImpl ?? fetch;
  const sessionsRoot =
    opts.sessionsRoot ?? path.join(nanoclawRoot, "data", "v2-sessions");

  const sessions: TeardownSessionResult[] = [];
  for (const sessionDir of listIdentitySessions(sessionsRoot)) {
    const identity = readIdentity(sessionDir);
    if (!identity) {
      sessions.push({
        sessionDir,
        machineDeleted: false,
        volumeDeleted: false,
        identityCleared: false,
        error: "invalid .fly-machine.json",
      });
      continue;
    }

    const row: TeardownSessionResult = {
      sessionDir,
      machineId: identity.machineId,
      volumeId: identity.volumeId,
      machineDeleted: false,
      volumeDeleted: false,
      identityCleared: false,
    };

    try {
      await flyDelete(
        apiBase,
        token,
        `/apps/${app}/machines/${identity.machineId}?force=true`,
        fetchImpl,
      );
      row.machineDeleted = true;
      await flyDelete(
        apiBase,
        token,
        `/apps/${app}/volumes/${identity.volumeId}`,
        fetchImpl,
      );
      row.volumeDeleted = true;
      fs.unlinkSync(path.join(sessionDir, IDENTITY));
      row.identityCleared = true;
    } catch (error) {
      /* v8 ignore next — non-Error throws are normalized for the summary line */
      row.error = error instanceof Error ? error.message : String(error);
    }
    sessions.push(row);
  }

  return {
    root: nanoclawRoot,
    app,
    sessions,
    machinesDeleted: sessions.filter((s) => s.machineDeleted).length,
    volumesDeleted: sessions.filter((s) => s.volumeDeleted).length,
    errors: sessions.filter((s) => s.error).length,
  };
}
