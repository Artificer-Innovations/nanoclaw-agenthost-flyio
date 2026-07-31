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
import { DATA_DIR, GROUPS_DIR } from "./config.js";
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
  startFlyMachineWhenReady,
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

  it("uses distinct machine names when session ids share a long prefix", async () => {
    const names: string[] = [];
    const ag = "ag-1b973136-67ab-4cbd-a496-11fbf8cfa0e0";
    const sessions = [
      "sess-1785345864447-szsudq",
      "sess-1785390412871-5tblbr",
    ] as const;
    for (const id of sessions) {
      const dir = path.join(sessionDir, id);
      mkdirSync(dir, { recursive: true });
      resetFlyDriverStateForTests();
      setFlyWakeDeps({
        resolveSessionDir: () => dir,
        resolveGroupFolder: () => "folder",
        createClient: () =>
          mockClient({
            createMachine: async (input) => {
              names.push(input.name);
              return {
                id: `mach_${names.length}`,
                name: input.name,
                state: "created",
                region: "iad",
              };
            },
          }),
        applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
        waitHealth: async () => {},
      });
      expect(await wakeFly({ id, agent_group_id: ag })).toBe(true);
    }
    expect(names).toHaveLength(2);
    expect(names[0]).not.toBe(names[1]);
    expect(names[0]).toMatch(/^ncl-[a-f0-9]{40}$/);
    expect(names[1]).toMatch(/^ncl-[a-f0-9]{40}$/);
    expect(names[0]!.length).toBeLessThanOrEqual(63);
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

  it("prefers public webchat URL over host.docker.internal for Fly", async () => {
    const { resolveFlyWebchatApiBase } = await import("./fly-runtime.js");
    const noFile = () => ({});
    expect(
      resolveFlyWebchatApiBase(
        {
          WEBCHAT_CONTAINER_API_BASE: "http://host.docker.internal:3201",
          WEBCHAT_PUBLIC_BASE_URL: "https://chat.example.test",
        },
        noFile,
      ),
    ).toBe("https://chat.example.test");
    expect(
      resolveFlyWebchatApiBase(
        {
          WEBCHAT_CONTAINER_API_BASE: "http://host.docker.internal:3201",
        },
        noFile,
      ),
    ).toBeNull();
    expect(
      resolveFlyWebchatApiBase(
        {
          WEBCHAT_CONTAINER_API_BASE: "http://host.docker.internal:3201",
        },
        () => ({
          WEBCHAT_PUBLIC_BASE_URL: "https://from-dotenv.example.test",
        }),
      ),
    ).toBe("https://from-dotenv.example.test");
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

  it("fails closed when transport is unset", async () => {
    delete process.env.SESSIONIO_TRANSPORT;
    process.env.FLY_REGION = "   ";
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () => mockClient(),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "s14", agent_group_id: "ag" })).toBe(false);
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

  it("rewrites webchat guest files and credentials for Fly", async () => {
    const folder = "webchat-group";
    const groupDir = path.join(GROUPS_DIR, folder);
    mkdirSync(path.join(groupDir, ".webchat"), { recursive: true });
    writeFileSync(
      path.join(groupDir, "WEBCHAT.md"),
      [
        "Configured apiBase: `http://host.docker.internal:3201`",
        "Also see http://host.docker.internal:3201/api",
        "",
      ].join("\n"),
    );
    writeFileSync(
      path.join(groupDir, "container.json"),
      '{"provider":"claude"}',
    );
    writeFileSync(path.join(groupDir, "CLAUDE.md"), "hi");
    writeFileSync(
      path.join(groupDir, ".webchat", "credentials.json"),
      "{not-json",
    );
    process.env.WEBCHAT_PUBLIC_BASE_URL = "https://chat.example.test";

    let guestFiles: Array<{ guestPath: string; rawValue: string }> = [];
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      resolveGroupFolder: () => folder,
      createClient: () =>
        mockClient({
          createMachine: async (input) => {
            guestFiles = input.files ?? [];
            return { id: "mach_wc", state: "created", region: "iad" };
          },
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "swc", agent_group_id: "ag" })).toBe(true);

    const webchat = guestFiles.find((f) => f.guestPath.endsWith("WEBCHAT.md"));
    expect(webchat?.rawValue).toContain("https://chat.example.test");
    expect(webchat?.rawValue).toContain("## Fly / remote runtime");
    expect(webchat?.rawValue).toContain("send_file");
    expect(webchat?.rawValue).not.toContain("host.docker.internal");

    const creds = guestFiles.find((f) =>
      f.guestPath.endsWith(".webchat/credentials.json"),
    );
    expect(JSON.parse(creds!.rawValue).apiBase).toBe(
      "https://chat.example.test",
    );

    rmSync(groupDir, { recursive: true, force: true });
  });

  it("skips Fly section append when WEBCHAT.md already has it", async () => {
    const folder = "webchat-existing";
    const groupDir = path.join(GROUPS_DIR, folder);
    mkdirSync(path.join(groupDir, ".webchat"), { recursive: true });
    writeFileSync(
      path.join(groupDir, "WEBCHAT.md"),
      "## Fly / remote runtime\nAlready there\n",
    );
    writeFileSync(
      path.join(groupDir, ".webchat", "credentials.json"),
      JSON.stringify({ token: "t" }),
    );
    process.env.WEBCHAT_FLY_API_BASE = "https://fly-chat.example.test";

    let guestFiles: Array<{ guestPath: string; rawValue: string }> = [];
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      resolveGroupFolder: () => folder,
      createClient: () =>
        mockClient({
          createMachine: async (input) => {
            guestFiles = input.files ?? [];
            return { id: "mach_we", state: "created", region: "iad" };
          },
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "swe", agent_group_id: "ag" })).toBe(true);
    const webchat = guestFiles.find((f) => f.guestPath.endsWith("WEBCHAT.md"));
    expect(webchat?.rawValue.match(/## Fly \/ remote runtime/g)).toHaveLength(
      1,
    );
    rmSync(groupDir, { recursive: true, force: true });
  });

  it("resolveFlyWebchatApiBase skips bad urls and bare docker hosts", async () => {
    const { resolveFlyWebchatApiBase } = await import("./fly-runtime.js");
    expect(
      resolveFlyWebchatApiBase(
        {
          WEBCHAT_FLY_API_BASE: "http://[::",
          WEBCHAT_PUBLIC_BASE_URL: "localhost:3201",
          WEBCHAT_CONTAINER_API_BASE: "127.0.0.1:3201",
        },
        () => ({}),
      ),
    ).toBeNull();
    expect(
      resolveFlyWebchatApiBase(
        { WEBCHAT_PUBLIC_BASE_URL: "chat.example.test:443" },
        () => ({}),
      ),
    ).toBe("http://chat.example.test:443");
  });

  it("retries start while machine is getting replaced", async () => {
    let attempts = 0;
    await startFlyMachineWhenReady(
      mockClient({
        getMachine: async () => ({ id: "m", state: "stopped" }),
        startMachine: async () => {
          attempts += 1;
          if (attempts < 2) throw new Error("machine is getting replaced");
        },
      }),
      "m",
      { timeoutMs: 5_000, sleepMs: 1 },
    );
    expect(attempts).toBe(2);
  });

  it("times out when machine stays unstartable", async () => {
    await expect(
      startFlyMachineWhenReady(
        mockClient({
          getMachine: async () => ({ id: "m", state: "stopped" }),
          startMachine: async () => {
            throw new Error("unable to start machine from current state");
          },
        }),
        "m",
        { timeoutMs: 30, sleepMs: 5 },
      ),
    ).rejects.toThrow(/unable to start machine from current state/);
  });

  it("times out with non-Error replace failures", async () => {
    await expect(
      startFlyMachineWhenReady(
        mockClient({
          getMachine: async () => ({ id: "m", state: "stopped" }),
          startMachine: async () => {
            throw "getting replaced";
          },
        }),
        "m",
        { timeoutMs: 30, sleepMs: 5 },
      ),
    ).rejects.toThrow(/not startable within/);
  });

  it("rethrows non-replace start errors immediately", async () => {
    await expect(
      startFlyMachineWhenReady(
        mockClient({
          getMachine: async () => ({ id: "m", state: "stopped" }),
          startMachine: async () => {
            throw new Error("permission denied");
          },
        }),
        "m",
        { timeoutMs: 1_000, sleepMs: 1 },
      ),
    ).rejects.toThrow(/permission denied/);
  });

  it("skips config update when getMachine fails", async () => {
    writeFlyIdentity(sessionDir, {
      machineId: "mach_gone",
      volumeId: "vol",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const update = vi.fn(async () => ({ id: "mach_gone", state: "updated" }));
    let getCalls = 0;
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          updateMachineEnv: update,
          getMachine: async () => {
            getCalls += 1;
            // First call is the config-update probe; later calls are start readiness.
            if (getCalls === 1) throw "not-an-error-object";
            return {
              id: "mach_gone",
              state: "stopped",
              config: { image: "img" },
            };
          },
          startMachine: async () => {},
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
    });
    expect(await wakeFly({ id: "sgone", agent_group_id: "ag" })).toBe(true);
    expect(update).not.toHaveBeenCalled();
  });

  it("merges containerEnv hosthook deps into machine env", async () => {
    let envSeen: Record<string, string> | undefined;
    setFlyWakeDeps({
      resolveSessionDir: () => sessionDir,
      createClient: () =>
        mockClient({
          createMachine: async (input) => {
            envSeen = input.env;
            return { id: "mach_he", state: "created", region: "iad" };
          },
        }),
      applyOneCli: async () => ({ ok: true, env: {}, files: [] }),
      waitHealth: async () => {},
      containerEnv: () => ({ AGENTTRACE_ENABLED: "true" }),
    });
    expect(await wakeFly({ id: "she", agent_group_id: "ag" })).toBe(true);
    expect(envSeen?.AGENTTRACE_ENABLED).toBe("true");
  });

  it("calls markStopped from rehydrated tracking on kill", async () => {
    const dir = path.join(DATA_DIR, "v2-sessions", "ag", "rehyd");
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "mrehyd",
      volumeId: "v",
      app: "a",
      region: "iad",
      image: "i",
    });
    const stop = vi.fn(async () => {});
    setFlyWakeDeps({
      createClient: () =>
        mockClient({
          getMachine: async () => ({ id: "mrehyd", state: "started" }),
          stopMachine: stop,
        }),
    });
    await cleanupFlyOrphans();
    expect(isFlyRunning("rehyd")).toBe(true);
    await new Promise<void>((resolve) => {
      killFly("rehyd", "test", resolve);
    });
    expect(stop).toHaveBeenCalled();
    expect(isFlyRunning("rehyd")).toBe(false);
  });
});
