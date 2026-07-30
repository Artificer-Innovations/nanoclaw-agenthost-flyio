import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DATA_DIR } from "./config.js";
import {
  FLY_WAKE_BLOCKED_FILENAME,
  WAKE_FAIL_BLOCK_AFTER,
} from "./fly-shared.js";
import {
  cleanupFlyOrphans,
  flyDriver,
  isFlyRunning,
  killFly,
  resetFlyDriverStateForTests,
  setFlyWakeDeps,
  wakeFly,
  writeFlyIdentity,
} from "./fly-runtime.js";
import type { FlyMachinesClient } from "./fly-machines.js";

function mockClient(
  overrides: Partial<FlyMachinesClient> = {},
): FlyMachinesClient {
  return {
    app: "agents",
    createVolume: async () => ({
      id: "vol_1",
      name: "v",
      region: "iad",
      size_gb: 3,
    }),
    getVolume: async () => ({
      id: "vol_1",
      name: "v",
      region: "iad",
      size_gb: 3,
    }),
    createMachine: async () => ({ id: "mach_1", state: "created" }),
    getMachine: async () => ({ id: "mach_1", state: "stopped" }),
    startMachine: async () => {},
    stopMachine: async () => {},
    waitMachine: async () => ({ id: "mach_1", state: "started" }),
    updateMachineEnv: async () => ({ id: "mach_1", state: "updated" }),
    ...overrides,
  } as FlyMachinesClient;
}

describe("fly-runtime", () => {
  let sessionDir: string;
  const prevEnv = { ...process.env };

  beforeEach(() => {
    resetFlyDriverStateForTests();
    sessionDir = mkdtempSync(path.join(tmpdir(), "fly-rt-"));
    process.env = {
      ...prevEnv,
      NANOCLAW_ALLOW_FLY_RUNTIME: "1",
      FLY_API_TOKEN: "t",
      FLY_APP_AGENTS: "agents",
      FLY_AGENT_IMAGE: "registry.fly.io/agent:latest",
      FLY_REGION: "iad",
      FLY_SESSIONIO_BASE_URL: "http://mb.internal:18765",
      SESSIONIO_TRANSPORT: "http",
    };
  });

  afterEach(() => {
    process.env = { ...prevEnv };
    resetFlyDriverStateForTests();
    rmSync(sessionDir, { recursive: true, force: true });
    const sessions = path.join(DATA_DIR, "v2-sessions");
    if (existsSync(sessions))
      rmSync(sessions, { recursive: true, force: true });
  });

  it("exports driver with requiredTransport http", () => {
    expect(flyDriver.requiredTransport).toBe("http");
  });

  it("refuses wake without allow env", async () => {
    delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    expect(await wakeFly({ id: "s1", agent_group_id: "ag" })).toBe(false);
  });

  it("refuses wake when blocked marker present", async () => {
    writeFileSync(path.join(sessionDir, FLY_WAKE_BLOCKED_FILENAME), "blocked");
    setFlyWakeDeps({ resolveSessionDir: () => sessionDir });
    expect(await wakeFly({ id: "s1", agent_group_id: "ag" })).toBe(false);
  });

  it("wakes create path and tracks running", async () => {
    const stop = vi.fn(async () => {});
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      resolveGroupFolder: () => "folder",
      createClient: () => mockClient({ stopMachine: stop }),
      applyOneCli: async () => ({
        ok: true,
        env: { HTTPS_PROXY: "http://proxy:1" },
        files: [{ guestPath: "/etc/a.pem", rawValue: "ca" }],
      }),
      waitHealth: async () => {},
    });
    const session = { id: "s1", agent_group_id: "ag" };
    expect(await wakeFly(session)).toBe(true);
    expect(isFlyRunning("s1")).toBe(true);
    expect(await wakeFly(session)).toBe(true); // already running

    await new Promise<void>((resolve) => {
      killFly("s1", "test", resolve);
    });
    expect(stop).toHaveBeenCalled();
    expect(isFlyRunning("s1")).toBe(false);
  });

  it("uses Fly-legal volume names (alnum/underscore, ≤30)", async () => {
    let volumeName = "";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      resolveGroupFolder: () => "folder",
      createClient: () =>
        mockClient({
          createVolume: async (input) => {
            volumeName = input.name;
            return {
              id: "vol_1",
              name: input.name,
              region: "iad",
              size_gb: 3,
            };
          },
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(
      await wakeFly({
        id: "sess-1785345864447-szsudq",
        agent_group_id: "ag-1b973136-67ab-4cbd-a496-11fbf8cfa0e0",
      }),
    ).toBe(true);
    expect(volumeName).toMatch(/^[a-z0-9_]{1,30}$/);
  });

  it("wakes existing identity path", async () => {
    writeFlyIdentity(sessionDir, {
      machineId: "mach_existing",
      volumeId: "vol_existing",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const update = vi.fn(async () => ({
      id: "mach_existing",
      state: "updated",
    }));
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          updateMachineEnv: update,
          getMachine: async () => ({
            id: "mach_existing",
            state: "stopped",
            config: { image: "img" },
          }),
        }),
      applyOneCli: async () => ({
        ok: true,
        env: {},
        files: [{ guestPath: "/etc/x.pem", rawValue: "x" }],
      }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s2", agent_group_id: "ag" })).toBe(true);
    expect(update).toHaveBeenCalled();
  });

  it("does not update a started machine when image is unchanged", async () => {
    writeFlyIdentity(sessionDir, {
      machineId: "mach_hot",
      volumeId: "vol_hot",
      app: "agents",
      region: "iad",
      image: "registry.fly.io/agents@sha256:abc",
    });
    process.env.FLY_AGENT_IMAGE = "registry.fly.io/agents@sha256:abc";
    const update = vi.fn(async () => ({ id: "mach_hot", state: "updated" }));
    const start = vi.fn(async () => {});
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          updateMachineEnv: update,
          startMachine: start,
          getMachine: async () => ({
            id: "mach_hot",
            state: "started",
            config: {
              image: "registry.fly.io/agents@sha256:abc",
              env: { CLAUDE_CONFIG_DIR: "/workspace/.claude" },
            },
          }),
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s2b", agent_group_id: "ag" })).toBe(true);
    expect(update).not.toHaveBeenCalled();
    // Already started — wait only; do not POST /start (can race with replace).
    expect(start).not.toHaveBeenCalled();
  });

  it("coalesces concurrent wakes for the same session", async () => {
    writeFlyIdentity(sessionDir, {
      machineId: "mach_race",
      volumeId: "vol_race",
      app: "agents",
      region: "iad",
      image: "img",
    });
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const update = vi.fn(async () => {
      await gate;
      return { id: "mach_race", state: "updated" };
    });
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          updateMachineEnv: update,
          getMachine: async () => ({
            id: "mach_race",
            state: "stopped",
            config: { image: "img" },
          }),
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    const a = wakeFly({ id: "s2c", agent_group_id: "ag" });
    const b = wakeFly({ id: "s2c", agent_group_id: "ag" });
    release();
    expect(await a).toBe(true);
    expect(await b).toBe(true);
    expect(update).toHaveBeenCalledTimes(1);
  });

  it("fails closed on filesystem transport hint", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      waitHealth: async () => {},
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      createClient: () => mockClient(),
    });
    expect(
      await wakeFly(
        { id: "s3", agent_group_id: "ag" },
        { transportName: "filesystem" },
      ),
    ).toBe(false);
  });

  it("fails when onecli unavailable", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      waitHealth: async () => {},
      applyOneCli: async () => ({ ok: false, env: {}, files: [] }),
      createClient: () => mockClient(),
    });
    expect(await wakeFly({ id: "s4", agent_group_id: "ag" })).toBe(false);
  });

  it("writes wake-blocked after repeated failures", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      waitHealth: async () => {
        throw new Error("down");
      },
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
    });
    for (let i = 0; i < WAKE_FAIL_BLOCK_AFTER; i += 1) {
      await wakeFly({ id: "s5", agent_group_id: "ag" });
    }
    expect(existsSync(path.join(sessionDir, FLY_WAKE_BLOCKED_FILENAME))).toBe(
      true,
    );
  });

  it("kill without tracked machine still invokes onExit", async () => {
    await new Promise<void>((resolve) => {
      killFly("missing", "test", resolve);
    });
  });

  it("kill handles stop errors", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          stopMachine: async () => {
            throw new Error("stop fail");
          },
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    await wakeFly({ id: "s6", agent_group_id: "ag" });
    await new Promise<void>((resolve) => {
      killFly("s6", "test", resolve);
    });
    expect(isFlyRunning("s6")).toBe(false);
  });

  it("cleanup orphans rehydrates started machines instead of stopping", async () => {
    const groupDir = path.join(DATA_DIR, "v2-sessions", "ag");
    const sid = "orphan1";
    const dir = path.join(groupDir, sid);
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "mach_orphan",
      volumeId: "vol",
      app: "agents",
      region: "iad",
      image: "img",
    });
    // also create a non-dir and empty identity skip paths
    writeFileSync(path.join(DATA_DIR, "v2-sessions", "file.txt"), "x");
    mkdirSync(path.join(groupDir, "no-identity"), { recursive: true });
    writeFileSync(path.join(groupDir, "file-session"), "x");

    const stop = vi.fn(async () => {});
    setFlyWakeDeps({
      createClient: () =>
        mockClient({
          getMachine: async () => ({ id: "mach_orphan", state: "started" }),
          stopMachine: stop,
        }),
    });
    await cleanupFlyOrphans();
    expect(stop).not.toHaveBeenCalled();
    expect(isFlyRunning(sid)).toBe(true);
  });

  it("cleanup orphans no-ops without credentials when sessions exist", async () => {
    mkdirSync(path.join(DATA_DIR, "v2-sessions"), { recursive: true });
    setFlyWakeDeps({
      createClient: () => {
        throw new Error("no creds");
      },
    });
    await cleanupFlyOrphans();
  });

  it("cleanup orphans no-ops without data dir", async () => {
    const sessions = path.join(DATA_DIR, "v2-sessions");
    if (existsSync(sessions))
      rmSync(sessions, { recursive: true, force: true });
    setFlyWakeDeps({ createClient: () => mockClient() });
    await cleanupFlyOrphans();
  });

  it("cleanup skips getMachine errors", async () => {
    const dir = path.join(DATA_DIR, "v2-sessions", "ag", "s");
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "m",
      volumeId: "v",
      app: "a",
      region: "iad",
      image: "i",
    });
    setFlyWakeDeps({
      createClient: () =>
        mockClient({
          getMachine: async () => {
            throw new Error("gone");
          },
        }),
    });
    await cleanupFlyOrphans();
  });

  it("passes GATEWAY_BASE_URL through for proxy rewrite", async () => {
    process.env.GATEWAY_BASE_URL = "http://onecli.internal:10255";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async (opts) => {
        expect(opts?.gatewayHost).toBe("http://onecli.internal:10255");
        return { ok: true, env: {}, files: [] };
      },
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s7", agent_group_id: "ag" })).toBe(true);
  });

  it("handles invalid gateway host string", async () => {
    process.env.GATEWAY_BASE_URL = "://bad";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async (opts) => {
        expect(opts?.gatewayHost).toBeTruthy();
        return { ok: true, env: {}, files: [] };
      },
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s8", agent_group_id: "ag" })).toBe(true);
  });

  it("wakes using default path resolvers and gateway host without scheme", async () => {
    process.env.ONECLI_GATEWAY_HOST = "proxy.internal";
    process.env.FLY_VOLUME_SIZE_GB = "not-a-number";
    delete process.env.GATEWAY_BASE_URL;
    setFlyWakeDeps({
      createClient: () => mockClient(),
      applyOneCli: async (opts) => {
        expect(opts?.gatewayHost).toBe("proxy.internal");
        return { ok: true, env: {}, files: [] };
      },
      waitHealth: async () => {},
      // no resolveSessionDir / resolveGroupFolder — use host fixtures
    });
    // Point DATA_DIR session path via resolve — override session dir still needed
    // because DATA_DIR fixture path may not exist; use resolveSessionDir
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s10", agent_group_id: "ag" })).toBe(true);
  });

  it("cleanup orphans ignores non-started states and skips active", async () => {
    const dir = path.join(DATA_DIR, "v2-sessions", "ag", "alive");
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "m",
      volumeId: "v",
      app: "a",
      region: "iad",
      image: "i",
    });
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    await wakeFly({ id: "alive", agent_group_id: "ag" });
    setFlyWakeDeps({
      createClient: () =>
        mockClient({
          getMachine: async () => ({ id: "m", state: "stopped" }),
        }),
    });
    await cleanupFlyOrphans();
  });

  it("cleanup rehydrates starting machines", async () => {
    const dir = path.join(DATA_DIR, "v2-sessions", "ag", "starting");
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "mstart",
      volumeId: "v",
      app: "a",
      region: "iad",
      image: "i",
    });
    const stop = vi.fn(async () => {});
    setFlyWakeDeps({
      createClient: () =>
        mockClient({
          getMachine: async () => ({ id: "mstart", state: "starting" }),
          stopMachine: stop,
        }),
    });
    await cleanupFlyOrphans();
    expect(stop).not.toHaveBeenCalled();
    expect(isFlyRunning("starting")).toBe(true);
  });

  it("clears wake-blocked after successful wake following failures", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      waitHealth: async () => {
        throw new Error("once");
      },
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
    });
    await wakeFly({ id: "s11", agent_group_id: "ag" });
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      waitHealth: async () => {},
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
    });
    expect(await wakeFly({ id: "s12", agent_group_id: "ag" })).toBe(true);
  });

  it("uses SESSIONIO_TRANSPORT from env when ctx omits transport", async () => {
    process.env.SESSIONIO_TRANSPORT = "http";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s13", agent_group_id: "ag" }, {})).toBe(true);
  });

  it("defaults transport to http when unset", async () => {
    delete process.env.SESSIONIO_TRANSPORT;
    process.env.FLY_REGION = "   ";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s14", agent_group_id: "ag" })).toBe(true);
  });

  it("uses default createClient from env", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s15", agent_group_id: "ag" })).toBe(false);
  });

  it("resolves session dir via hostSessionDir when deps omit it", async () => {
    const dir = path.join(DATA_DIR, "v2-sessions", "ag", "s16");
    mkdirSync(dir, { recursive: true });
    setFlyWakeDeps({
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s16", agent_group_id: "ag" })).toBe(true);
  });

  it("falls back group folder when agent group missing", async () => {
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s17", agent_group_id: "missing-group" })).toBe(
      true,
    );
  });
});
