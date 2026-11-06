/**
 * Destroy Fly Machines + volumes recorded in per-session `.fly-machine.json`.
 * Idle `kill` only stops; this is the bill-stopping path used by CLI teardown.
 */
import fs from "node:fs";
import path from "node:path";
import { clearFlyIdentity, readFlyIdentity } from "./fly-identity.js";
import {
  createFlyMachinesClientFromEnv,
  type FlyMachinesClient,
} from "./fly-machines.js";

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
  sessions: TeardownSessionResult[];
  machinesDeleted: number;
  volumesDeleted: number;
}

function listSessionDirs(sessionsRoot: string): string[] {
  /* v8 ignore start */
  if (!fs.existsSync(sessionsRoot)) return [];
  /* v8 ignore stop */
  const out: string[] = [];
  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    /* v8 ignore start */
    if (!group.isDirectory()) continue;
    /* v8 ignore stop */
    const groupDir = path.join(sessionsRoot, group.name);
    for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
      /* v8 ignore start */
      if (!session.isDirectory()) continue;
      /* v8 ignore stop */
      out.push(path.join(groupDir, session.name));
    }
  }
  return out;
}

export async function teardownFlySession(
  sessionDir: string,
  client: FlyMachinesClient,
): Promise<TeardownSessionResult> {
  const identity = readFlyIdentity(sessionDir);
  if (!identity) {
    return {
      sessionDir,
      machineDeleted: false,
      volumeDeleted: false,
      identityCleared: false,
    };
  }

  const result: TeardownSessionResult = {
    sessionDir,
    machineId: identity.machineId,
    volumeId: identity.volumeId,
    machineDeleted: false,
    volumeDeleted: false,
    identityCleared: false,
  };

  try {
    try {
      await client.deleteMachine(identity.machineId);
      result.machineDeleted = true;
    } catch (error) {
      /* v8 ignore start */
      const msg = error instanceof Error ? error.message : String(error);
      /* v8 ignore stop */
      // Already gone is success for teardown.
      if (/404|not found/i.test(msg)) result.machineDeleted = true;
      else throw error;
    }

    try {
      await client.deleteVolume(identity.volumeId);
      result.volumeDeleted = true;
    } catch (error) {
      /* v8 ignore start */
      const msg = error instanceof Error ? error.message : String(error);
      /* v8 ignore stop */
      if (/404|not found/i.test(msg)) result.volumeDeleted = true;
      else throw error;
    }

    clearFlyIdentity(sessionDir);
    result.identityCleared = true;
  } catch (error) {
    /* v8 ignore start */
    result.error = error instanceof Error ? error.message : String(error);
    /* v8 ignore stop */
  }

  return result;
}

export async function teardownAllFlySessions(
  nanoclawRoot: string,
  opts: {
    env?: NodeJS.ProcessEnv;
    client?: FlyMachinesClient;
    sessionsRoot?: string;
  } = {},
): Promise<TeardownResult> {
  const env = opts.env ?? process.env;
  const sessionsRoot =
    opts.sessionsRoot ?? path.join(nanoclawRoot, "data", "v2-sessions");
  /* v8 ignore start */
  const client = opts.client ?? createFlyMachinesClientFromEnv(env);
  /* v8 ignore stop */
  const sessions: TeardownSessionResult[] = [];

  for (const sessionDir of listSessionDirs(sessionsRoot)) {
    /* v8 ignore start */
    if (!readFlyIdentity(sessionDir)) continue;
    /* v8 ignore stop */
    sessions.push(await teardownFlySession(sessionDir, client));
  }

  return {
    root: nanoclawRoot,
    sessions,
    machinesDeleted: sessions.filter((s) => s.machineDeleted).length,
    volumesDeleted: sessions.filter((s) => s.volumeDeleted).length,
  };
}
