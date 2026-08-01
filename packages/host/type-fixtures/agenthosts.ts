/**
 * CI-only stub — real module exists once nanoclaw-agenthosts is installed into a NanoClaw host.
 */
export const AGENTHOSTS_API_VERSION = 1 as const;

export interface SessionRef {
  id: string;
  agent_group_id: string;
}

export type RuntimeStatusFn = (
  phase: string,
  summary: string,
  extra?: { state?: "started" | "progress" | "succeeded" | "failed" },
) => void;

export interface WakeContext {
  onStatus?: RuntimeStatusFn;
  [key: string]: unknown;
}

export interface RuntimeDriver {
  wake(session: SessionRef, ctx: WakeContext): Promise<boolean>;
  kill(sessionId: string, reason: string, onExit?: () => void): void;
  isRunning(sessionId: string): boolean;
  cleanupOrphans?(): void | Promise<void>;
  buildImage?(agentGroupId: string, opts?: unknown): Promise<void>;
  requiredTransport?: string | string[];
}

const drivers = new Map<string, RuntimeDriver>();

export function registerRuntimeDriver(
  name: string,
  driver: RuntimeDriver,
): () => void {
  drivers.set(name, driver);
  return () => {
    drivers.delete(name);
  };
}

export function resolveRuntimeDriver(_session: SessionRef): RuntimeDriver {
  throw new Error(
    "resolveRuntimeDriver is provided by nanoclaw-agenthosts at runtime",
  );
}
