import fs, { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_WORKING_ROOT,
  ensureFlyWorkspace,
  isFlyRemotePeerMode,
} from "./workspace.js";
import { registerFlyRunner } from "./register.js";

describe("runner workspace", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("ensures workspace dirs", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-ws-"));
    const root = ensureFlyWorkspace({
      workingRoot: dir,
      groupFolder: "g1",
    });
    expect(root).toBe(dir);
    expect(existsSync(path.join(dir, "agent"))).toBe(true);
    expect(existsSync(path.join(dir, "groups", "g1"))).toBe(true);
    expect(existsSync(path.join(dir, "inbound.db"))).toBe(true);
    expect(existsSync(path.join(dir, "outbound.db"))).toBe(true);
    expect(DEFAULT_WORKING_ROOT).toBe("/workspace");
  });

  it("copies bootstrap agent files onto the volume", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-ws-boot-"));
    const boot = path.join(dir, "boot");
    fs.mkdirSync(boot);
    fs.writeFileSync(
      path.join(boot, "container.json"),
      '{"provider":"claude"}',
    );
    const nested = path.join(boot, ".webchat");
    fs.mkdirSync(nested);
    fs.writeFileSync(path.join(nested, "credentials.json"), '{"ok":true}');
    // Broken symlink / unreadable entry should be best-effort skipped.
    fs.symlinkSync(
      path.join(boot, "missing-target"),
      path.join(boot, "broken-link"),
    );
    const root = path.join(dir, "ws");
    ensureFlyWorkspace({
      workingRoot: root,
      groupFolder: "g1",
      bootstrapDir: boot,
    });
    expect(
      fs.readFileSync(path.join(root, "agent", "container.json"), "utf8"),
    ).toContain("claude");
    expect(
      fs.readFileSync(
        path.join(root, "agent", ".webchat", "credentials.json"),
        "utf8",
      ),
    ).toContain("ok");
  });

  it("skips missing bootstrap dir", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-ws-noboot-"));
    ensureFlyWorkspace({
      workingRoot: dir,
      groupFolder: "g1",
      bootstrapDir: path.join(dir, "nope"),
    });
    expect(existsSync(path.join(dir, "agent"))).toBe(true);
  });

  it("detects remote peer mode", () => {
    expect(isFlyRemotePeerMode({})).toBe(false);
    expect(
      isFlyRemotePeerMode({
        SESSIONIO_BASE_URL: "http://x",
        SESSIONIO_TRANSPORT: "http",
      }),
    ).toBe(true);
    expect(
      isFlyRemotePeerMode({
        SESSIONIO_BASE_URL: "http://x",
      }),
    ).toBe(true);
    expect(
      isFlyRemotePeerMode({
        SESSIONIO_BASE_URL: "http://x",
        SESSIONIO_TRANSPORT: "loopback",
      }),
    ).toBe(true);
    expect(
      isFlyRemotePeerMode({
        SESSIONIO_BASE_URL: "http://x",
        SESSIONIO_TRANSPORT: "filesystem",
      }),
    ).toBe(false);
  });

  it("ensureFlyWorkspace uses env defaults", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-ws-def-"));
    const prev = process.env.WORKING_ROOT;
    const prevGroup = process.env.NANOCLAW_GROUP_FOLDER;
    process.env.WORKING_ROOT = dir;
    delete process.env.NANOCLAW_GROUP_FOLDER;
    try {
      const root = ensureFlyWorkspace();
      expect(root).toBe(dir);
      expect(existsSync(path.join(dir, "groups", "default"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKING_ROOT;
      else process.env.WORKING_ROOT = prev;
      if (prevGroup === undefined) delete process.env.NANOCLAW_GROUP_FOLDER;
      else process.env.NANOCLAW_GROUP_FOLDER = prevGroup;
    }
  });

  it("ensureFlyWorkspace falls back to DEFAULT_WORKING_ROOT with custom mkdir", () => {
    const made: string[] = [];
    const prev = process.env.WORKING_ROOT;
    delete process.env.WORKING_ROOT;
    try {
      ensureFlyWorkspace({
        groupFolder: "x",
        mkdir: ((p: fs.PathLike) => {
          made.push(String(p));
        }) as typeof fs.mkdirSync,
      });
      expect(made.some((p) => p.includes("workspace"))).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKING_ROOT;
      else process.env.WORKING_ROOT = prev;
    }
  });

  it("swallows ensurePeerSqlite failures (writable-volume assumption)", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-ws-sqlite-fail-"));
    expect(() =>
      ensureFlyWorkspace({
        workingRoot: dir,
        groupFolder: "g1",
        ensurePeerSqlite: () => {
          throw new Error("simulated sqlite bootstrap failure");
        },
      }),
    ).not.toThrow();
    expect(existsSync(path.join(dir, "agent"))).toBe(true);
  });

  it("registerFlyRunner bootstraps or skips", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-reg-"));
    const logs: string[] = [];
    const log = {
      info: (m: string) => logs.push(m),
      warn: (m: string) => logs.push(m),
    };
    expect(registerFlyRunner({}, log)).toBeNull();
    expect(logs.some((l) => /skipping/.test(l))).toBe(true);
    const root = registerFlyRunner(
      {
        SESSIONIO_BASE_URL: "http://mb",
        SESSIONIO_TRANSPORT: "http",
        WORKING_ROOT: dir,
        NANOCLAW_GROUP_FOLDER: "g",
      },
      log,
    );
    expect(root).toBe(dir);
  });

  it("registerFlyRunner uses default log sinks", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-reg-def-"));
    expect(registerFlyRunner({})).toBeNull();
    expect(
      registerFlyRunner({
        SESSIONIO_BASE_URL: "http://mb",
        WORKING_ROOT: dir,
      }),
    ).toBe(dir);
  });
});
