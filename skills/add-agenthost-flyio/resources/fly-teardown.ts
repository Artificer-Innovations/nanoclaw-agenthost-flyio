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
  if (!fs.existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  for (const group of fs.readdirSync(sessionsRoot, { withFileTypes: true })) {
    if (!group.isDirectory()) continue;
    const groupDir = path.join(sessionsRoot, group.name);
    for (const session of fs.readdirSync(groupDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
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
      const msg = error instanceof Error ? error.message : String(error);
      // Already gone is success for teardown.
      if (/404|not found/i.test(msg)) result.machineDeleted = true;
      else throw error;
    }

    try {
      await client.deleteVolume(identity.volumeId);
      result.volumeDeleted = true;
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/404|not found/i.test(msg)) result.volumeDeleted = true;
      else throw error;
    }

    clearFlyIdentity(sessionDir);
    result.identityCleared = true;
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
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
  const client = opts.client ?? createFlyMachinesClientFromEnv(env);
  const sessions: TeardownSessionResult[] = [];

  for (const sessionDir of listSessionDirs(sessionsRoot)) {
    if (!readFlyIdentity(sessionDir)) continue;
    sessions.push(await teardownFlySession(sessionDir, client));
  }

  return {
    root: nanoclawRoot,
    sessions,
    machinesDeleted: sessions.filter((s) => s.machineDeleted).length,
    volumesDeleted: sessions.filter((s) => s.volumeDeleted).length,
  };
}
