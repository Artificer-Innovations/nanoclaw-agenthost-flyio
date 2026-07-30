import { describe, expect, it, vi } from "vitest";
import {
  FlyMachinesClient,
  createFlyMachinesClientFromEnv,
} from "./fly-machines.js";

function jsonResponse(
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("FlyMachinesClient", () => {
  it("creates volume and machine", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (url.includes("/volumes") && init?.method === "POST") {
        return jsonResponse({
          id: "vol_1",
          name: "v",
          region: "iad",
          size_gb: 3,
        });
      }
      if (url.includes("/machines") && init?.method === "POST") {
        return jsonResponse({ id: "mach_1", state: "created" });
      }
      return jsonResponse({});
    });

    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    const vol = await client.createVolume({
      name: "vol",
      region: "iad",
      sizeGb: 3,
    });
    expect(vol.id).toBe("vol_1");
    const machine = await client.createMachine({
      name: "m",
      region: "iad",
      image: "img",
      env: { A: "1" },
      volumeId: "vol_1",
      files: [{ guestPath: "/etc/a.pem", rawValue: "cert" }],
    });
    expect(machine.id).toBe("mach_1");
    expect(calls.some((c) => c.body?.includes("raw_value"))).toBe(true);
  });

  it("retries on 429 then succeeds", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) {
        return new Response("slow", {
          status: 429,
          headers: { "retry-after": "0" },
        });
      }
      return jsonResponse({ id: "mach_2", state: "started" });
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    const machine = await client.getMachine("mach_2");
    expect(machine.id).toBe("mach_2");
    expect(n).toBe(2);
  });

  it("retries network errors", async () => {
    let n = 0;
    const fetchImpl = vi.fn(async () => {
      n += 1;
      if (n === 1) throw new TypeError("fetch failed");
      return jsonResponse({ id: "mach_3" });
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 2,
    });
    expect((await client.getMachine("mach_3")).id).toBe("mach_3");
  });

  it("throws on non-ok responses", async () => {
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => new Response("nope", { status: 500 }),
      sleep: async () => {},
      maxRetries: 0,
    });
    await expect(client.startMachine("x")).rejects.toThrow(/500/);
  });

  it("handles empty and 204 bodies", async () => {
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => new Response(null, { status: 204 }),
      sleep: async () => {},
    });
    await expect(client.stopMachine("x")).resolves.toBeUndefined();

    const client2 = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => new Response("", { status: 200 }),
      sleep: async () => {},
    });
    await expect(client2.startMachine("x")).resolves.toBeUndefined();
  });

  it("wait and update helpers", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("/wait"))
        return jsonResponse({ id: "m", state: "started" });
      return jsonResponse({ id: "m", state: "updated" });
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl,
      sleep: async () => {},
    });
    expect((await client.waitMachine("m", "started")).state).toBe("started");
    expect((await client.updateMachineEnv("m", { env: {} })).state).toBe(
      "updated",
    );
    expect((await client.getVolume("v")).id).toBe("m");
  });

  it("createFlyMachinesClientFromEnv validates", () => {
    expect(() => createFlyMachinesClientFromEnv({})).toThrow(/FLY_API_TOKEN/);
    expect(() =>
      createFlyMachinesClientFromEnv({ FLY_API_TOKEN: "t" }),
    ).toThrow(/FLY_APP_AGENTS/);
    const client = createFlyMachinesClientFromEnv({
      FLY_API_TOKEN: "t",
      FLY_APP_AGENTS: "agents",
      FLY_MACHINES_API_BASE: "https://example.test/v1/",
    });
    expect(client.app).toBe("agents");
  });

  it("uses default fetchImpl and sleep when not provided on success path", async () => {
    // Cover constructor defaults without calling defaultSleep (health ok first try).
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => jsonResponse({ id: "x" }),
      // omit sleep — uses defaultSleep only on retry; no retry here
      maxRetries: 0,
    });
    expect((await client.getMachine("x")).id).toBe("x");
  });

  it("createMachine without files uses empty list", async () => {
    const fetchImpl = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ id: "mach_nf", state: "created" }),
    );
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl,
      sleep: async () => {},
    });
    await client.createMachine({
      name: "m",
      region: "iad",
      image: "img",
      env: {},
      volumeId: "v",
    });
    const init = fetchImpl.mock.calls[0]?.[1];
    const body = JSON.parse((init?.body as string) ?? "{}");
    expect(body.config.files).toEqual([]);
  });

  it("retries 429 without retry-after header", async () => {
    let n = 0;
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => {
        n += 1;
        if (n === 1) return new Response("slow", { status: 429 });
        return jsonResponse({ id: "ok" });
      },
      sleep: async () => {},
      maxRetries: 2,
    });
    expect((await client.getMachine("x")).id).toBe("ok");
  });

  it("treats 429 as error when retries exhausted", async () => {
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => new Response("slow", { status: 429 }),
      sleep: async () => {},
      maxRetries: 0,
    });
    await expect(client.getMachine("x")).rejects.toThrow(/429/);
  });

  it("retries ECONN-style errors", async () => {
    let n = 0;
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => {
        n += 1;
        if (n === 1) throw new Error("ECONNRESET");
        return jsonResponse({ id: "ok" });
      },
      sleep: async () => {},
      maxRetries: 2,
    });
    expect((await client.getMachine("x")).id).toBe("ok");
  });
});
