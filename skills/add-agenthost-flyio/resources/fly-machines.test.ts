import { describe, expect, it, vi } from "vitest";
import {
  FlyMachinesClient,
  createFlyMachinesClientFromEnv,
  isAttachableVolumeState,
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

describe("isAttachableVolumeState", () => {
  it("allows created / omitted state; rejects empty, terminal, or unknown", () => {
    expect(isAttachableVolumeState(undefined)).toBe(true);
    expect(isAttachableVolumeState("")).toBe(false);
    expect(isAttachableVolumeState("   ")).toBe(false);
    expect(isAttachableVolumeState("created")).toBe(true);
    expect(isAttachableVolumeState("CREATED")).toBe(true);
    expect(isAttachableVolumeState("  created  ")).toBe(true);
    expect(isAttachableVolumeState("pending_destroy")).toBe(false);
    expect(isAttachableVolumeState("scheduling_destroy")).toBe(false);
    expect(isAttachableVolumeState("dead")).toBe(false);
    expect(isAttachableVolumeState("unavailable")).toBe(false);
  });
});

describe("FlyMachinesClient", () => {
  it("creates volume and machine", async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({
        url,
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([]);
      }
      if (
        url.endsWith("/machines") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([]);
      }
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
    expect(
      calls.some((c) => c.method === "GET" && c.url.endsWith("/volumes")),
    ).toBe(true);
  });

  it("reuses volume/machine by deterministic name", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          { id: "vol_existing", name: "vol", region: "iad", size_gb: 3 },
        ]);
      }
      if (
        url.endsWith("/machines") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          { id: "mach_existing", name: "m", state: "stopped" },
        ]);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    expect(
      (
        await client.createVolume({
          name: "vol",
          region: "iad",
          sizeGb: 3,
        })
      ).id,
    ).toBe("vol_existing");
    expect(
      (
        await client.createMachine({
          name: "m",
          region: "iad",
          image: "img",
          env: {},
          volumeId: "vol_existing",
        })
      ).id,
    ).toBe("mach_existing");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("skips pending_destroy volumes and creates a fresh one", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          {
            id: "vol_dying",
            name: "vol",
            region: "iad",
            size_gb: 3,
            state: "pending_destroy",
          },
          {
            id: "vol_dead",
            name: "vol",
            region: "iad",
            size_gb: 3,
            state: "scheduling_destroy",
          },
        ]);
      }
      if (url.includes("/volumes") && init?.method === "POST") {
        return jsonResponse({
          id: "vol_fresh",
          name: "vol",
          region: "iad",
          size_gb: 3,
          state: "created",
        });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    expect(
      (
        await client.createVolume({
          name: "vol",
          region: "iad",
          sizeGb: 3,
        })
      ).id,
    ).toBe("vol_fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("prefers an attachable volume when a destroy twin shares the name", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          {
            id: "vol_dying",
            name: "vol",
            region: "iad",
            size_gb: 3,
            state: "pending_destroy",
          },
          {
            id: "vol_ok",
            name: "vol",
            region: "iad",
            size_gb: 3,
            state: "created",
          },
        ]);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    expect(
      (
        await client.createVolume({
          name: "vol",
          region: "iad",
          sizeGb: 3,
        })
      ).id,
    ).toBe("vol_ok");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("skips unknown volume states (fail closed) and creates a fresh one", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          {
            id: "vol_weird",
            name: "vol",
            region: "iad",
            size_gb: 3,
            state: "unavailable",
          },
        ]);
      }
      if (url.includes("/volumes") && init?.method === "POST") {
        return jsonResponse({
          id: "vol_fresh",
          name: "vol",
          region: "iad",
          size_gb: 3,
          state: "created",
        });
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    expect(
      (
        await client.createVolume({
          name: "vol",
          region: "iad",
          sizeGb: 3,
        })
      ).id,
    ).toBe("vol_fresh");
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("reuses volumes that omit state (legacy list payloads)", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/volumes") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([
          { id: "vol_legacy", name: "vol", region: "iad", size_gb: 3 },
        ]);
      }
      throw new Error(`unexpected ${init?.method} ${url}`);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    expect(
      (
        await client.createVolume({
          name: "vol",
          region: "iad",
          sizeGb: 3,
        })
      ).id,
    ).toBe("vol_legacy");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not retry create on network errors; looks up by name instead", async () => {
    let postAttempts = 0;
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/machines") &&
        (!init?.method || init.method === "GET")
      ) {
        if (postAttempts === 0) return jsonResponse([]);
        return jsonResponse([
          { id: "mach_recovered", name: "m", state: "created" },
        ]);
      }
      if (url.includes("/machines") && init?.method === "POST") {
        postAttempts += 1;
        throw new TypeError("fetch failed");
      }
      return jsonResponse([]);
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 3,
    });
    const machine = await client.createMachine({
      name: "m",
      region: "iad",
      image: "img",
      env: {},
      volumeId: "v",
    });
    expect(machine.id).toBe("mach_recovered");
    expect(postAttempts).toBe(1);
  });

  it("passes AbortSignal.timeout on fetch", async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(init?.signal).toBeDefined();
      expect(init?.signal?.aborted).toBe(false);
      return jsonResponse({ id: "mach_sig" });
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 0,
    });
    await client.getMachine("mach_sig");
    expect(fetchImpl).toHaveBeenCalled();
  });

  it("rethrows create errors when name lookup finds nothing", async () => {
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        (url.endsWith("/volumes") || url.endsWith("/machines")) &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([]);
      }
      if (init?.method === "POST") {
        return new Response("boom", { status: 500 });
      }
      return jsonResponse({});
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
      maxRetries: 0,
    });
    await expect(
      client.createVolume({ name: "vol", region: "iad", sizeGb: 3 }),
    ).rejects.toThrow(/500/);
    await expect(
      client.createMachine({
        name: "m",
        region: "iad",
        image: "img",
        env: {},
        volumeId: "v",
      }),
    ).rejects.toThrow(/500/);
  });

  it("treats non-array list payloads as empty", async () => {
    const client = new FlyMachinesClient({
      token: "t",
      app: "a",
      fetchImpl: async () => jsonResponse({ not: "an-array" }),
      sleep: async () => {},
      maxRetries: 0,
    });
    expect(await client.listVolumes()).toEqual([]);
    expect(await client.listMachines()).toEqual([]);
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

  it("deleteMachine and deleteVolume issue DELETE", async () => {
    const calls: string[] = [];
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method ?? "GET"} ${url}`);
        return new Response(null, { status: 204 });
      },
      sleep: async () => {},
    });
    await client.deleteMachine("mach_1");
    await client.deleteMachine("mach_2", false);
    await client.deleteVolume("vol_1");
    expect(
      calls.some((c) => c.includes("DELETE") && c.includes("/machines/mach_1")),
    ).toBe(true);
    expect(calls.some((c) => c.includes("force=true"))).toBe(true);
    expect(
      calls.some(
        (c) =>
          c.includes("DELETE") &&
          c.includes("/machines/mach_2") &&
          !c.includes("force"),
      ),
    ).toBe(true);
    expect(
      calls.some((c) => c.includes("DELETE") && c.includes("/volumes/vol_1")),
    ).toBe(true);
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
    const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
      if (
        url.endsWith("/machines") &&
        (!init?.method || init.method === "GET")
      ) {
        return jsonResponse([]);
      }
      return jsonResponse({ id: "mach_nf", state: "created" });
    });
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
    const postCall = fetchImpl.mock.calls.find((c) => c[1]?.method === "POST");
    const body = JSON.parse((postCall?.[1]?.body as string) ?? "{}");
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
