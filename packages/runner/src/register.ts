/**
 * Optional register hook for agent-runner images built for Fly.
 * sessionio peer registration remains owned by nanoclaw-sessionio.
 */
import { ensureFlyWorkspace, isFlyRemotePeerMode } from "./workspace.js";

export interface FlyRunnerLog {
  info: (msg: string) => void;
  warn: (msg: string) => void;
}

/**
 * Prepare volume workspace when running as a Fly remote peer.
 * Returns working root or null when not in remote peer mode.
 */
export function registerFlyRunner(
  env: NodeJS.ProcessEnv = process.env,
  log: FlyRunnerLog = {
    /* v8 ignore next 2 */
    info: () => {},
    warn: () => {},
  },
): string | null {
  if (!isFlyRemotePeerMode(env)) {
    log.warn(
      "fly runner: SESSIONIO_BASE_URL not set — skipping workspace bootstrap",
    );
    return null;
  }
  const root = ensureFlyWorkspace({
    workingRoot: env.WORKING_ROOT,
    groupFolder: env.NANOCLAW_GROUP_FOLDER,
  });
  log.info(`fly runner: workspace ready at ${root}`);
  return root;
}
