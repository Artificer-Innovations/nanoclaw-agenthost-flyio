/**
 * Volume workspace bootstrap for Fly agent Machines.
 * Mailbox IO stays on sessionio HTTP peer — this only prepares /workspace.
 */
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_WORKING_ROOT = "/workspace";

export interface EnsureFlyWorkspaceOpts {
  workingRoot?: string;
  groupFolder?: string;
  mkdir?: typeof fs.mkdirSync;
}

/**
 * Ensure memory / groups dirs exist on the attached volume.
 */
export function ensureFlyWorkspace(opts: EnsureFlyWorkspaceOpts = {}): string {
  const root =
    opts.workingRoot ?? process.env.WORKING_ROOT ?? DEFAULT_WORKING_ROOT;
  const mkdir = opts.mkdir ?? fs.mkdirSync;
  const groupFolder =
    opts.groupFolder ?? process.env.NANOCLAW_GROUP_FOLDER ?? "default";

  mkdir(root, { recursive: true });
  mkdir(path.join(root, "agent"), { recursive: true });
  mkdir(path.join(root, "groups", groupFolder), { recursive: true });
  mkdir(path.join(root, "inbox"), { recursive: true });
  mkdir(path.join(root, "outbox"), { recursive: true });
  return root;
}

/** True when the runner should use sessionio remote peer mode. */
export function isFlyRemotePeerMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const transport = (env.SESSIONIO_TRANSPORT ?? "").trim().toLowerCase();
  const base = (env.SESSIONIO_BASE_URL ?? "").trim();
  return (
    Boolean(base) &&
    (transport === "http" || transport === "loopback" || !transport)
  );
}
