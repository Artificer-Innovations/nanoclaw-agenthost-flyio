/**
 * NanoClaw does not dotenv-load arbitrary keys into process.env.
 * Fly boot applies host opt-in / Fly config keys from `.env` when unset.
 */
import { FLY_HOST_ENV_KEYS, type FlyHostEnvKey } from "./fly-shared.js";

export { FLY_HOST_ENV_KEYS, type FlyHostEnvKey };

export function applyFlyHostEnvFromFile(
  env: NodeJS.ProcessEnv = process.env,
  readFile: (keys: string[]) => Record<string, string> = () => ({}),
): void {
  const fromFile = readFile([...FLY_HOST_ENV_KEYS]);
  for (const key of FLY_HOST_ENV_KEYS) {
    const value = fromFile[key]?.trim();
    if (value && !env[key]?.trim()) {
      env[key] = value;
    }
  }
}
