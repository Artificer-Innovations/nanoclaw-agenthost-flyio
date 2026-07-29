import { describe, expect, it } from "vitest";
import {
  applyFlyOneCli,
  buildCombinedCaBundlePem,
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
    expect(env.HTTPS_PROXY).toBe("http://proxy.internal:10255");
    expect(env.OTHER).toBe("ok");
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
});
