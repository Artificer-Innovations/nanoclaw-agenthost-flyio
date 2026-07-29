/**
 * Materialize OneCLI proxy env + CA material for a Fly Machine guest.
 * Rewrites Docker-oriented hostnames; returns env + guest files (not host paths).
 */
import { ONECLI_API_KEY, ONECLI_URL } from "./config.js";

export interface FlyOneCliClient {
  ensureAgent(opts: { name: string; identifier: string }): Promise<unknown>;
  getContainerConfig(opts?: { agent?: string }): Promise<{
    env: Record<string, string>;
    caCertificate?: string;
    caCertificateContainerPath?: string;
    combinedCaCertificate?: string;
    combinedCaCertificateContainerPath?: string;
    credentialStubs?: Array<{ containerPath: string; content: string }>;
  } | null>;
}

export interface ApplyFlyOneCliOpts {
  agentIdentifier?: string;
  agentName?: string;
  /** Rewrite target for host.docker.internal (reachable from the Machine). */
  gatewayHost?: string;
  /** Guest paths for CA files inside the Machine. */
  guestCaDir?: string;
  client?: FlyOneCliClient;
}

export interface FlyGuestFile {
  guestPath: string;
  rawValue: string;
}

export interface ApplyFlyOneCliResult {
  ok: boolean;
  env: Record<string, string>;
  files: FlyGuestFile[];
}

/* v8 ignore start */
async function defaultClient(): Promise<FlyOneCliClient> {
  const { OneCLI } = await import("@onecli-sh/sdk");
  return new OneCLI({
    url: process.env.ONECLI_URL || ONECLI_URL,
    apiKey: process.env.ONECLI_API_KEY || ONECLI_API_KEY,
  });
}
/* v8 ignore stop */

/**
 * Replace host.docker.internal with a host the Machine can reach
 * (GATEWAY_BASE_URL host, WireGuard IP, or Flycast — operator-supplied).
 */
export function rewriteDockerInternalHostnames(
  env: Record<string, string>,
  gatewayHost = "127.0.0.1",
): void {
  for (const [key, value] of Object.entries(env)) {
    if (value.includes("host.docker.internal")) {
      env[key] = value.split("host.docker.internal").join(gatewayHost);
    }
  }
}

export function buildCombinedCaBundlePem(
  gatewayCaPem: string,
  systemCaPem?: string,
): string {
  if (!systemCaPem) return `${gatewayCaPem.trimEnd()}\n`;
  return `${systemCaPem.trimEnd()}\n${gatewayCaPem.trimEnd()}\n`;
}

/**
 * Fetch OneCLI container-config and shape it for Fly Machine env + files.
 * Fail-closed when gateway config is unavailable.
 */
export async function applyFlyOneCli(
  opts: ApplyFlyOneCliOpts = {},
): Promise<ApplyFlyOneCliResult> {
  /* v8 ignore next */
  const client = opts.client ?? (await defaultClient());
  const guestCaDir = opts.guestCaDir ?? "/etc/onecli";

  if (opts.agentIdentifier) {
    await client.ensureAgent({
      name: opts.agentName ?? opts.agentIdentifier,
      identifier: opts.agentIdentifier,
    });
  }

  const config = await client.getContainerConfig(
    opts.agentIdentifier ? { agent: opts.agentIdentifier } : undefined,
  );
  if (!config?.env) {
    return { ok: false, env: {}, files: [] };
  }

  const env: Record<string, string> = { ...config.env };
  const files: FlyGuestFile[] = [];

  if (config.caCertificate) {
    const guestPath = `${guestCaDir}/onecli-gateway-ca.pem`;
    files.push({ guestPath, rawValue: config.caCertificate });
    env.NODE_EXTRA_CA_CERTS = guestPath;
  }

  const combinedPem =
    config.combinedCaCertificate ??
    (config.caCertificate
      ? buildCombinedCaBundlePem(config.caCertificate)
      : undefined);
  if (combinedPem) {
    const guestPath = `${guestCaDir}/onecli-combined-ca.pem`;
    files.push({ guestPath, rawValue: combinedPem });
    env.SSL_CERT_FILE = guestPath;
    env.DENO_CERT = guestPath;
  }

  for (const stub of config.credentialStubs ?? []) {
    files.push({
      guestPath: stub.containerPath,
      rawValue: stub.content,
    });
  }

  // Drop leftover /tmp SDK paths that only make sense on Docker hosts.
  for (const key of Object.keys(env)) {
    const value = env[key];
    if (
      (key === "NODE_EXTRA_CA_CERTS" ||
        key === "SSL_CERT_FILE" ||
        key === "DENO_CERT") &&
      value.startsWith("/tmp/")
    ) {
      delete env[key];
    }
  }

  rewriteDockerInternalHostnames(env, opts.gatewayHost ?? "127.0.0.1");

  // Never bake management credentials into the Machine.
  for (const key of Object.keys(env)) {
    if (key.startsWith("ONECLI_API_KEY") || key === "ONECLI_API_KEY") {
      delete env[key];
    }
  }

  return { ok: true, env, files };
}
