/**
 * Host-side helpers around sessionio HTTP for Fly agents.
 * Does not register a separate SessionTransport — reuses `http`.
 */
import type { SessionRef } from "./agenthosts.js";

export interface SessionioReadinessOpts {
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  retries?: number;
  sleep?: (ms: number) => Promise<void>;
}

/* v8 ignore start */
function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
/* v8 ignore stop */

/** True when transport name is the network mailbox (not filesystem). */
export function isHttpSessionTransport(
  name: string | undefined | null,
): boolean {
  /* v8 ignore next — trim of nullish coalesced empty string */
  const n = (name ?? "").trim().toLowerCase();
  return n === "http" || n === "loopback";
}

/**
 * Fail closed if a fly wake is attempted with filesystem mailbox.
 */
export function assertHttpTransportForFly(
  transportName: string | undefined | null,
): void {
  if (!isHttpSessionTransport(transportName)) {
    throw new Error(
      /* v8 ignore next */
      `fly runtime requires session transport "http" (got "${transportName ?? "filesystem"}")`,
    );
  }
}

/**
 * Resolve the mailbox URL agents on Fly must dial.
 * Prefer FLY_SESSIONIO_BASE_URL (reachable via 6PN / WireGuard / Flycast),
 * else SESSIONIO_BASE_URL.
 */
export function resolveFlySessionioBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const dedicated = (env.FLY_SESSIONIO_BASE_URL ?? "").trim();
  if (dedicated) return stripTrailingSlash(dedicated);
  const base = (env.SESSIONIO_BASE_URL ?? "").trim();
  if (base) return stripTrailingSlash(base);
  throw new Error(
    "FLY_SESSIONIO_BASE_URL or SESSIONIO_BASE_URL is required for fly agents",
  );
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

function mergeNoProxy(current: string | undefined, extra: string): string {
  const parts = new Set(
    `${current ?? ""},${extra}`
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean),
  );
  return [...parts].join(",");
}

/**
 * Env injected into the Machine so the agent-runner speaks sessionio HTTP peer.
 */
export function buildFlySessionioEnv(
  session: SessionRef,
  hostEnv: NodeJS.ProcessEnv = process.env,
  overrides: Record<string, string> = {},
): Record<string, string> {
  const baseUrl = resolveFlySessionioBaseUrl(hostEnv);
  const token = (hostEnv.SESSIONIO_HTTP_TOKEN ?? "").trim();
  let hostname = "localhost";
  try {
    hostname = new URL(baseUrl).hostname;
  } catch {
    // keep localhost
  }

  const env: Record<string, string> = {
    SESSIONIO_TRANSPORT: "http",
    SESSIONIO_BASE_URL: baseUrl,
    SESSIONIO_SESSION_ID: session.id,
    SESSIONIO_AGENT_GROUP_ID: session.agent_group_id,
    WORKING_ROOT: "/workspace",
  };
  if (token) env.SESSIONIO_HTTP_TOKEN = token;

  const noProxyExtra = `${hostname},localhost,127.0.0.1,.internal,.flycast`;
  env.NO_PROXY = mergeNoProxy(hostEnv.NO_PROXY, noProxyExtra);
  env.no_proxy = mergeNoProxy(hostEnv.no_proxy, noProxyExtra);

  return { ...env, ...overrides };
}

/**
 * Poll sessionio host `/health` until ready (or throw).
 */
export async function waitForSessionioHealth(
  opts: SessionioReadinessOpts,
): Promise<void> {
  /* v8 ignore next 4 — defaults exercised via explicit opts in unit tests */
  const fetchImpl = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const retries = opts.retries ?? 10;
  const sleep = opts.sleep ?? defaultSleep;
  const base = stripTrailingSlash(opts.baseUrl);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (let i = 0; i <= retries; i += 1) {
    if (Date.now() > deadline) break;
    try {
      const response = await fetchImpl(`${base}/health`, { headers });
      if (response.ok) return;
      lastError = new Error(`sessionio /health status ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    if (i < retries && Date.now() <= deadline) {
      await sleep(Math.min(1000, 100 * 2 ** i));
    }
  }
  throw new Error(
    `sessionio HTTP not ready at ${base}/health: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  );
}
