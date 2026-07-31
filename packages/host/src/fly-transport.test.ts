import { describe, expect, it, vi } from "vitest";
import {
  assertHttpTransportForFly,
  buildFlySessionioEnv,
  isHttpSessionTransport,
  resolveFlySessionioBaseUrl,
  waitForSessionioHealth,
} from "./fly-transport.js";

describe("fly-transport", () => {
  it("detects http transports", () => {
    expect(isHttpSessionTransport("http")).toBe(true);
    expect(isHttpSessionTransport("loopback")).toBe(true);
    expect(isHttpSessionTransport("filesystem")).toBe(false);
    expect(() => assertHttpTransportForFly("filesystem")).toThrow(/http/);
    expect(() => assertHttpTransportForFly("http")).not.toThrow();
  });

  it("resolves sessionio base url", () => {
    expect(
      resolveFlySessionioBaseUrl({
        FLY_SESSIONIO_BASE_URL: "http://host.flycast:18765/",
      }),
    ).toBe("http://host.flycast:18765");
    expect(
      resolveFlySessionioBaseUrl({
        SESSIONIO_BASE_URL: "http://10.0.0.1:18765",
      }),
    ).toBe("http://10.0.0.1:18765");
    expect(() => resolveFlySessionioBaseUrl({})).toThrow(/SESSIONIO_BASE_URL/);
  });

  it("builds fly sessionio env", () => {
    const env = buildFlySessionioEnv(
      { id: "s1", agent_group_id: "ag1" },
      {
        FLY_SESSIONIO_BASE_URL: "http://mb.internal:18765",
        SESSIONIO_HTTP_TOKEN: "tok",
        NO_PROXY: "extra",
      },
    );
    expect(env.SESSIONIO_TRANSPORT).toBe("http");
    expect(env.SESSIONIO_SESSION_ID).toBe("s1");
    expect(env.SESSIONIO_HTTP_TOKEN).toBe("tok");
    expect(env.NO_PROXY).toContain("mb.internal");
    expect(env.NO_PROXY).toContain("extra");
  });

  it("handles invalid base url hostname in env builder", () => {
    const env = buildFlySessionioEnv(
      { id: "s1", agent_group_id: "ag1" },
      { FLY_SESSIONIO_BASE_URL: "not a url" },
    );
    expect(env.SESSIONIO_BASE_URL).toBe("not a url");
    expect(env.NO_PROXY).toContain("localhost");
  });

  it("waits for sessionio health", async () => {
    let n = 0;
    await waitForSessionioHealth({
      baseUrl: "http://mb/",
      token: "t",
      retries: 2,
      timeoutMs: 5000,
      sleep: async () => {},
      fetchImpl: (async () => {
        n += 1;
        if (n < 2) return new Response("no", { status: 503 });
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    expect(n).toBe(2);
  });

  it("builds env without token and with no_proxy merge", () => {
    const env = buildFlySessionioEnv(
      { id: "s1", agent_group_id: "ag1" },
      {
        FLY_SESSIONIO_BASE_URL: "http://mb.internal:18765",
        no_proxy: "prior",
      },
    );
    expect(env.SESSIONIO_HTTP_TOKEN).toBeUndefined();
    expect(env.no_proxy).toContain("prior");
  });

  it("waitForSessionioHealth uses default retries/timeouts with ok response", async () => {
    await waitForSessionioHealth({
      baseUrl: "http://mb",
      sleep: async () => {},
      fetchImpl: (async () =>
        new Response("{}", { status: 200 })) as typeof fetch,
    });
  });

  it("throws when health never ready with non-Error", async () => {
    await expect(
      waitForSessionioHealth({
        baseUrl: "http://mb",
        retries: 0,
        timeoutMs: 5_000,
        sleep: async () => {},
        fetchImpl: (async () => {
          throw "down";
        }) as typeof fetch,
      }),
    ).rejects.toThrow(/not ready/);
  });

  it("breaks when deadline exceeded", async () => {
    await expect(
      waitForSessionioHealth({
        baseUrl: "http://mb",
        retries: 5,
        timeoutMs: 0,
        sleep: async () => {},
        fetchImpl: (async () =>
          new Response("no", { status: 503 })) as typeof fetch,
      }),
    ).rejects.toThrow(/not ready/);
  });
});
