import { describe, expect, it } from "vitest";
import {
  applyFlyOneCli,
  buildCombinedCaBundlePem,
  gatewayAuthorityFromBase,
  rewriteDockerInternalHostnames,
  type FlyOneCliClient,
} from "./fly-onecli.js";

describe("fly-onecli", () => {
  it("rewrites docker internal hostnames", () => {
    const env = {
      HTTPS_PROXY: "http://host.docker.internal:10255",
      OTHER: "ok",
    };
    rewriteDockerInternalHostnames(env, "proxy.internal");
    expect(env.HTTPS_PROXY).toBe("http://proxy.internal");
    expect(env.OTHER).toBe("ok");
  });

  it("rewrites docker proxy port using GATEWAY_BASE_URL authority", () => {
    const env = {
      HTTPS_PROXY: "http://x:tok@host.docker.internal:10255",
    };
    rewriteDockerInternalHostnames(
      env,
      "https://bhg-onecli-proxy.ngrok-free.dev",
    );
    expect(env.HTTPS_PROXY).toBe(
      "https://x:tok@bhg-onecli-proxy.ngrok-free.dev",
    );
  });

  it("leaves http proxy scheme when gateway is http", () => {
    const env = {
      HTTPS_PROXY: "http://x:tok@host.docker.internal:10255",
    };
    rewriteDockerInternalHostnames(env, "http://onecli.internal:10255");
    expect(env.HTTPS_PROXY).toBe("http://x:tok@onecli.internal:10255");
  });

  it("builds combined CA pem", () => {
    expect(buildCombinedCaBundlePem("G")).toContain("G");
    expect(buildCombinedCaBundlePem("G", "S")).toContain("S");
  });

  it("fail-closed when config missing", async () => {
    const client: FlyOneCliClient = {
      ensureAgent: async () => ({}),
      getContainerConfig: async () => null,
    };
    const result = await applyFlyOneCli({
      client,
      agentIdentifier: "ag",
    });
    expect(result.ok).toBe(false);
  });

  it("materializes env and guest files", async () => {
    const client: FlyOneCliClient = {
      ensureAgent: async () => ({}),
      getContainerConfig: async () => ({
        env: {
          HTTPS_PROXY: "http://host.docker.internal:10255",
          ONECLI_API_KEY: "secret",
          NODE_EXTRA_CA_CERTS: "/tmp/gone.pem",
        },
        caCertificate: "GATEWAY_CA",
        credentialStubs: [
          { containerPath: "/home/node/.codex/auth.json", content: "{}" },
        ],
      }),
    };
    const result = await applyFlyOneCli({
      client,
      agentIdentifier: "ag",
      agentName: "Scout",
      gatewayHost: "gw.flycast",
    });
    expect(result.ok).toBe(true);
    expect(result.env.HTTPS_PROXY).toContain("gw.flycast");
    expect(result.env.ONECLI_API_KEY).toBeUndefined();
    expect(result.env.NODE_EXTRA_CA_CERTS).toBe(
      "/etc/onecli/onecli-gateway-ca.pem",
    );
    expect(result.env.SSL_CERT_FILE).toBe("/etc/onecli/onecli-combined-ca.pem");
    expect(result.files.some((f) => f.guestPath.endsWith("auth.json"))).toBe(
      true,
    );
  });

  it("drops leftover /tmp cert env without regenerating", async () => {
    const client: FlyOneCliClient = {
      ensureAgent: async () => ({}),
      getContainerConfig: async () => ({
        env: {
          SSL_CERT_FILE: "/tmp/gone.pem",
          DENO_CERT: "/tmp/gone.pem",
          NODE_EXTRA_CA_CERTS: "/tmp/gone.pem",
          KEEP: "1",
        },
      }),
    };
    const result = await applyFlyOneCli({ client });
    expect(result.ok).toBe(true);
    expect(result.env.SSL_CERT_FILE).toBeUndefined();
    expect(result.env.DENO_CERT).toBeUndefined();
    expect(result.env.NODE_EXTRA_CA_CERTS).toBeUndefined();
    expect(result.env.KEEP).toBe("1");
  });

  it("handles empty credential stubs", async () => {
    const client: FlyOneCliClient = {
      ensureAgent: async () => ({}),
      getContainerConfig: async () => ({
        env: { A: "1" },
        credentialStubs: [],
      }),
    };
    const result = await applyFlyOneCli({ client, gatewayHost: undefined });
    expect(result.ok).toBe(true);
    expect(result.files).toEqual([]);
  });

  it("gatewayAuthorityFromBase falls back on invalid urls", () => {
    expect(gatewayAuthorityFromBase("")).toBe("127.0.0.1");
    expect(gatewayAuthorityFromBase("http://", "fb")).toBe("fb");
    expect(gatewayAuthorityFromBase("host.only:1234")).toBe("host.only:1234");
  });
});
