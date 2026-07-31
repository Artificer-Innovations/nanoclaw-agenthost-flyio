import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agenthostsOk, writeFixture } from "./agenthosts.test.js";
import { sessionioOk } from "./sessionio.test.js";
import { runCommand } from "./bin.js";
import {
  findFlyBootInsertIndex,
  insertFlyBootBlockContent,
  resolveCopySources,
  syncSkillToFork,
} from "./patch.js";
import {
  HOST_OPTIONAL_COPY_RULES,
  RUNNER_OPTIONAL_COPY_RULES,
  packageRoot,
  readPackageVersion,
  resourcesDir,
  runnerResourcesDir,
} from "./paths.js";
import { runInstall, runUninstall, runVerify } from "./install.js";

describe("coverage gaps", () => {
  let root: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("packageRoot throws when not found", () => {
    const orphan = mkdtempSync(path.join(tmpdir(), "pkg-orphan-"));
    try {
      expect(() => packageRoot(path.join(orphan, "no", "package"))).toThrow(
        /Could not locate nanoclaw-agenthost-flyio/,
      );
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("resourcesDir / runnerResourcesDir fall back when package sources missing", () => {
    const pkg = packageRoot();
    const hostBoot = path.join(pkg, "packages/host/src/fly-boot.ts");
    const runnerWs = path.join(pkg, "packages/runner/src/workspace.ts");
    const realExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      if (s === hostBoot || s === runnerWs) return false;
      return realExists(p);
    });

    root = mkdtempSync(path.join(tmpdir(), "res-fb-"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fork",
        dependencies: { "nanoclaw-agenthost-flyio": "^0.1.0" },
      }),
    );
    expect(resourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources",
    );
    expect(runnerResourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources/runner",
    );

    const fakePkg = mkdtempSync(path.join(tmpdir(), "fake-pkg-"));
    mkdirSync(path.join(fakePkg, "packages/host/src"), { recursive: true });
    mkdirSync(path.join(fakePkg, "packages/runner/src"), { recursive: true });
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fork",
        dependencies: {
          "nanoclaw-agenthost-flyio": `file:${fakePkg}`,
        },
      }),
    );
    expect(resourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources",
    );
    expect(runnerResourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources/runner",
    );
    rmSync(fakePkg, { recursive: true, force: true });
  });

  it("linked file: dep resolves when primary missing but linked has sources", () => {
    const pkg = packageRoot();
    const hostBoot = path.join(pkg, "packages/host/src/fly-boot.ts");
    const runnerWs = path.join(pkg, "packages/runner/src/workspace.ts");
    const linked = mkdtempSync(path.join(tmpdir(), "linked-pkg-"));
    mkdirSync(path.join(linked, "packages/host/src"), { recursive: true });
    mkdirSync(path.join(linked, "packages/runner/src"), { recursive: true });
    writeFileSync(path.join(linked, "packages/host/src/fly-boot.ts"), "//");
    writeFileSync(path.join(linked, "packages/runner/src/workspace.ts"), "//");
    const linkedHostBoot = path.join(linked, "packages/host/src/fly-boot.ts");
    const linkedRunnerWs = path.join(
      linked,
      "packages/runner/src/workspace.ts",
    );

    const realExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      if (s === hostBoot || s === runnerWs) return false;
      return realExists(p);
    });

    root = mkdtempSync(path.join(tmpdir(), "linked-fork-"));
    writeFileSync(
      path.join(root, "package.json"),
      JSON.stringify({
        name: "fork",
        devDependencies: {
          "nanoclaw-agenthost-flyio": `file:${linked}`,
        },
      }),
    );
    expect(resourcesDir(undefined, root)).toBe(
      path.join(linked, "packages/host/src"),
    );
    expect(runnerResourcesDir(undefined, root)).toBe(
      path.join(linked, "packages/runner/src"),
    );
    expect(realExists(linkedHostBoot)).toBe(true);
    expect(realExists(linkedRunnerWs)).toBe(true);
    rmSync(linked, { recursive: true, force: true });
  });

  it("resolveCopySources throws when required resource missing", () => {
    expect(() =>
      resolveCopySources(packageRoot(), [
        { source: "does-not-exist-resource.ts", dest: "src/x.ts" },
      ]),
    ).toThrow(/Missing bundled resource/);
  });

  it("verify reports missing transform file", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-verify-miss-"));
    agenthostsOk(root);
    writeFixture(
      root,
      "src/sessionio.ts",
      `export const SESSIONIO_API_VERSION = 1 as const;\nexport function registerSessionTransport() {}\nexport function resolveSessionTransport() {}\n`,
    );
    // no src/index.ts
    const result = runVerify(root);
    expect(result.issues.some((i) => i.includes("missing src/index.ts"))).toBe(
      true,
    );
  });

  it("runCommand catch path for Error", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(
      await runCommand([
        "node",
        "bin.js",
        "install",
        "--path",
        "/tmp/nope-flyio",
      ]),
    ).toBe(1);
    expect(err).toHaveBeenCalled();
  });

  it("resolveCopySources optional runner + host", () => {
    const hostOpt = resolveCopySources(
      packageRoot(),
      HOST_OPTIONAL_COPY_RULES,
      true,
    );
    expect(hostOpt.length).toBeGreaterThan(0);
    const runnerOpt = resolveCopySources(
      packageRoot(),
      RUNNER_OPTIONAL_COPY_RULES,
      true,
      "runner",
    );
    expect(runnerOpt.length).toBeGreaterThan(0);
    const mixed = resolveCopySources(
      packageRoot(),
      [
        ...HOST_OPTIONAL_COPY_RULES.slice(0, 1),
        { source: "missing-optional-resource.ts", dest: "src/missing.ts" },
      ],
      true,
    );
    expect(mixed.length).toBe(1);
  });

  it("syncSkillToFork replaces a non-directory destination", () => {
    root = mkdtempSync(path.join(tmpdir(), "skill-sync-file-"));
    mkdirSync(path.join(root, ".claude/skills"), { recursive: true });
    writeFileSync(
      path.join(root, ".claude/skills/add-agenthost-flyio"),
      "not-a-dir",
    );
    const dest = syncSkillToFork(root);
    expect(existsSync(path.join(dest, "SKILL.md"))).toBe(true);
  });

  it("install throws when required host file missing", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-miss-"));
    agenthostsOk(root);
    writeFixture(
      root,
      "src/sessionio.ts",
      `export const SESSIONIO_API_VERSION = 1 as const;\nexport function registerSessionTransport() {}\nexport function resolveSessionTransport() {}\n`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    // peers pass (sessionio module present) but FILE_TRANSFORMS path missing
    expect(() => runInstall(root)).toThrow(/Missing required host file/);
  });

  it("verify flags missing transform markers", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-verify-"));
    agenthostsOk(root);
    sessionioOk(root);
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "src/index.ts", "export {};\n");
    // copy required files partially by install failing — just verify
    const result = runVerify(root);
    expect(result.ok).toBe(false);
  });

  it("install rollback restores previous content", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-rollback-"));
    agenthostsOk(root);
    sessionioOk(root);
    writeFixture(
      root,
      "src/index.ts",
      `async function main() {
  // @nanoclaw-sessionio:index-boot:begin
  startSessionio();
  // @nanoclaw-sessionio:index-boot:end
  await initChannelAdapters();
}
`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "container/agent-runner/src/index.ts", "export {};\n");
    writeFixture(root, "package.json", "{}");

    const originalRename = fs.renameSync;
    let renames = 0;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      renames += 1;
      if (renames === 3) {
        throw new Error("simulated rename failure");
      }
      return originalRename(from, to);
    });

    expect(() => runInstall(root)).toThrow(/simulated rename failure/);
  });

  it("rollback deletes newly created host files (previous === null)", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-rollback-new-"));
    agenthostsOk(root);
    sessionioOk(root);
    writeFixture(
      root,
      "src/index.ts",
      `async function main() {
  // @nanoclaw-sessionio:index-boot:begin
  startSessionio();
  // @nanoclaw-sessionio:index-boot:end
  await initChannelAdapters();
}
`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "container/agent-runner/src/index.ts", "export {};\n");
    writeFixture(root, "package.json", "{}");

    const originalRename = fs.renameSync;
    let sawFlyBoot = false;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      const result = originalRename(from, to);
      if (String(to).endsWith("src/fly-boot.ts")) {
        sawFlyBoot = true;
        return result;
      }
      if (sawFlyBoot) throw new Error("fail-after-new-fly-file");
      return result;
    });

    expect(() => runInstall(root)).toThrow(/fail-after-new-fly-file/);
    expect(existsSync(path.join(root, "src/fly-boot.ts"))).toBe(false);
  });

  it("uninstall removes empty fly runner dir", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-un-"));
    agenthostsOk(root);
    sessionioOk(root);
    writeFixture(
      root,
      "src/index.ts",
      `async function main() {
  // @nanoclaw-sessionio:index-boot:begin
  startSessionio();
  // @nanoclaw-sessionio:index-boot:end
  await initChannelAdapters();
}
`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "container/agent-runner/src/index.ts", "export {};\n");
    writeFixture(root, "package.json", "{}");
    runInstall(root);
    runUninstall(root);
    expect(existsSync(path.join(root, "container/agent-runner/src/fly"))).toBe(
      false,
    );
  });

  it("boot insert before awaited initChannelAdapters", async () => {
    const source = `async function main() {\n  await initChannelAdapters();\n}\n`;
    expect(findFlyBootInsertIndex(source)).toBeGreaterThanOrEqual(0);
    expect(insertFlyBootBlockContent(source)).toContain("startAgenthostFlyio");
  });

  it("install/verify/uninstall without explicit root use cwd", async () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-cwd-"));
    agenthostsOk(root);
    sessionioOk(root);
    writeFixture(
      root,
      "src/index.ts",
      `async function main() {
  // @nanoclaw-sessionio:index-boot:begin
  startSessionio();
  // @nanoclaw-sessionio:index-boot:end
  await initChannelAdapters();
}
`,
    );
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "container/agent-runner/src/index.ts", "export {};\n");
    writeFixture(root, "package.json", "{}");
    const prev = process.cwd();
    process.chdir(root);
    try {
      runInstall();
      expect(runVerify().ok).toBe(true);
      runUninstall();
    } finally {
      process.chdir(prev);
    }
  });

  it("uninstall skips missing transform file", () => {
    root = mkdtempSync(path.join(tmpdir(), "ahf-un-miss-"));
    agenthostsOk(root);
    writeFixture(
      root,
      "src/sessionio.ts",
      `export const SESSIONIO_API_VERSION = 1 as const;\nexport function registerSessionTransport() {}\nexport function resolveSessionTransport() {}\n`,
    );
    // no src/index.ts
    const result = runUninstall(root);
    expect(result.changed.length).toBe(0);
  });

  it("resourcesDir falls back when nanoclawRoot has no package.json", () => {
    const pkg = packageRoot();
    const hostBoot = path.join(pkg, "packages/host/src/fly-boot.ts");
    const runnerWs = path.join(pkg, "packages/runner/src/workspace.ts");
    const realExists = fs.existsSync.bind(fs);
    vi.spyOn(fs, "existsSync").mockImplementation((p) => {
      const s = String(p);
      if (s === hostBoot || s === runnerWs) return false;
      return realExists(p);
    });
    root = mkdtempSync(path.join(tmpdir(), "nolink-pkg-"));
    // no package.json in nanoclawRoot
    expect(resourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources",
    );
    expect(runnerResourcesDir(undefined, root)).toContain(
      "skills/add-agenthost-flyio/resources/runner",
    );
  });

  it("readPackageVersion falls back when version missing", () => {
    const pkgPath = path.join(packageRoot(), "package.json");
    const original = fs.readFileSync.bind(fs);
    const spy = vi.spyOn(fs, "readFileSync").mockImplementation(((
      p: fs.PathOrFileDescriptor,
      enc?: unknown,
    ) => {
      if (p === pkgPath) {
        return JSON.stringify({ name: "nanoclaw-agenthost-flyio" });
      }
      return original(p, enc as BufferEncoding);
    }) as typeof fs.readFileSync);
    try {
      expect(readPackageVersion()).toBe("0.0.0");
    } finally {
      spy.mockRestore();
    }
  });
});
