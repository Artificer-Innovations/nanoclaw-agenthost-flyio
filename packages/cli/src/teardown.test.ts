import fs, {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCommand } from "./bin.js";
import { runTeardown } from "./teardown.js";

describe("runTeardown", () => {
  let dir: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("destroys identities under data/v2-sessions", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({
        machineId: "m1",
        volumeId: "v1",
        app: "agents",
        region: "iad",
        image: "img",
      }),
    );

    const calls: string[] = [];
    const result = await runTeardown(dir, {
      fetchImpl: async (url: string, init?: RequestInit) => {
        calls.push(`${init?.method} ${url}`);
        return new Response(null, { status: 204 });
      },
    });

    expect(result.machinesDeleted).toBe(1);
    expect(result.volumesDeleted).toBe(1);
    expect(result.errors).toBe(0);
    expect(existsSync(path.join(sessionDir, ".fly-machine.json"))).toBe(false);
    expect(calls.some((c) => c.includes("/machines/m1"))).toBe(true);
  });

  it("throws when Fly creds missing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-nocred-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    await expect(runTeardown(dir, { env: {} })).rejects.toThrow(
      /FLY_API_TOKEN/,
    );
  });

  it("reads single-quoted .env values and skips non-dir entries", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-quote-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN='tok'\nFLY_APP_AGENTS='agents'\n",
    );
    const sessions = path.join(dir, "data", "v2-sessions");
    mkdirSync(sessions, { recursive: true });
    writeFileSync(path.join(sessions, "not-a-group.txt"), "x\n");
    const group = path.join(sessions, "ag");
    mkdirSync(group, { recursive: true });
    writeFileSync(path.join(group, "not-a-session.txt"), "x\n");
    const result = await runTeardown(dir, {
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(result.app).toBe("agents");
    expect(result.sessions).toEqual([]);
  });

  it("runTeardown without root uses findNanoclawRoot from cwd", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-cwd-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    mkdirSync(path.join(dir, "src/channels"), { recursive: true });
    writeFileSync(path.join(dir, "src/channels/index.ts"), "export {};\n");
    writeFileSync(path.join(dir, "src/index.ts"), "export {};\n");
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const result = await runTeardown(undefined, {
        fetchImpl: async () => new Response(null, { status: 204 }),
      });
      expect(result.root).toBe(fs.realpathSync(dir));
    } finally {
      process.chdir(prev);
    }
  });

  it("throws when app missing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-noapp-"));
    await expect(
      runTeardown(dir, { env: { FLY_API_TOKEN: "t" } }),
    ).rejects.toThrow(/FLY_APP_AGENTS/);
  });

  it("records invalid identity and API errors", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-bad-"));
    writeFileSync(
      path.join(dir, ".env"),
      'FLY_API_TOKEN="tok"\nFLY_APP_AGENTS=agents\n',
    );
    const bad = path.join(dir, "data", "v2-sessions", "ag", "bad");
    const good = path.join(dir, "data", "v2-sessions", "ag", "good");
    mkdirSync(bad, { recursive: true });
    mkdirSync(good, { recursive: true });
    writeFileSync(path.join(bad, ".fly-machine.json"), "{not-json");
    writeFileSync(
      path.join(good, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1", volumeId: "v1" }),
    );
    const result = await runTeardown(dir, {
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    expect(result.errors).toBeGreaterThan(0);
    expect(result.sessions.some((s) => s.error?.includes("invalid"))).toBe(
      true,
    );
  });

  it("treats 404 as success", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-404-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\nFLY_MACHINES_API_BASE=https://api.example/v1/\n",
    );
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1", volumeId: "v1" }),
    );
    const result = await runTeardown(dir, {
      fetchImpl: async () => new Response("gone", { status: 404 }),
    });
    expect(result.machinesDeleted).toBe(1);
    expect(result.volumesDeleted).toBe(1);
    expect(result.errors).toBe(0);
  });

  it("teardown command via runCommand", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-cmd-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1", volumeId: "v1" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // Patch global fetch for the command path
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    try {
      expect(
        await runCommand(["node", "bin.js", "teardown", "--path", dir]),
      ).toBe(0);
    } finally {
      globalThis.fetch = prev;
      log.mockRestore();
    }
  });

  it("teardown command returns 1 and prints per-session errors", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-errcmd-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1", volumeId: "v1" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response("nope", { status: 500 })) as typeof fetch;
    try {
      expect(
        await runCommand(["node", "bin.js", "teardown", "--path", dir]),
      ).toBe(1);
      expect(err.mock.calls.some((c) => String(c[0]).includes("sess"))).toBe(
        true,
      );
    } finally {
      globalThis.fetch = prev;
      log.mockRestore();
      err.mockRestore();
    }
  });

  it("skips identity JSON missing machineId/volumeId", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-td-partial-"));
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1" }),
    );
    const result = await runTeardown(dir, {
      fetchImpl: async () => new Response(null, { status: 204 }),
    });
    expect(result.sessions[0]?.error).toMatch(/invalid/);
    expect(result.machinesDeleted).toBe(0);
  });

  it("uninstall prints teardown summary when destroy succeeds", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-un-ok-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    mkdirSync(path.join(dir, "src/channels"), { recursive: true });
    writeFileSync(path.join(dir, "src/channels/index.ts"), "export {};\n");
    writeFileSync(path.join(dir, "src/index.ts"), "export {};\n");
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFileSync(
      path.join(sessionDir, ".fly-machine.json"),
      JSON.stringify({ machineId: "m1", volumeId: "v1" }),
    );
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const prev = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    try {
      expect(
        await runCommand(["node", "bin.js", "uninstall", "--path", dir]),
      ).toBe(0);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("Remote Fly teardown"),
        ),
      ).toBe(true);
    } finally {
      globalThis.fetch = prev;
      log.mockRestore();
    }
  });

  it("uninstall without --path uses result.root for teardown", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-un-cwd-"));
    writeFileSync(path.join(dir, "package.json"), "{}");
    writeFileSync(
      path.join(dir, ".env"),
      "FLY_API_TOKEN=tok\nFLY_APP_AGENTS=agents\n",
    );
    mkdirSync(path.join(dir, "src/channels"), { recursive: true });
    writeFileSync(path.join(dir, "src/channels/index.ts"), "export {};\n");
    writeFileSync(path.join(dir, "src/index.ts"), "export {};\n");
    const prev = process.cwd();
    process.chdir(dir);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const prevFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(null, { status: 204 })) as typeof fetch;
    try {
      expect(await runCommand(["node", "bin.js", "uninstall"])).toBe(0);
      expect(
        log.mock.calls.some((c) =>
          String(c[0]).includes("Remote Fly teardown"),
        ),
      ).toBe(true);
    } finally {
      globalThis.fetch = prevFetch;
      process.chdir(prev);
      log.mockRestore();
    }
  });

  it("uninstall best-effort teardown when creds missing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "ahf-un-td-"));
    // Minimal fork so uninstall can run (will fail peer checks on install — use runUninstall path via runCommand after seeding)
    writeFileSync(path.join(dir, "package.json"), "{}");
    mkdirSync(path.join(dir, "src/channels"), { recursive: true });
    writeFileSync(path.join(dir, "src/channels/index.ts"), "export {};\n");
    writeFileSync(path.join(dir, "src/index.ts"), "export {};\n");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    // uninstall without agenthosts files still removes nothing but attempts teardown
    const code = await runCommand([
      "node",
      "bin.js",
      "uninstall",
      "--path",
      dir,
    ]);
    expect(code).toBe(0);
    expect(err.mock.calls.some((c) => String(c[0]).includes("teardown"))).toBe(
      true,
    );
    err.mockRestore();
    log.mockRestore();
  });
});
