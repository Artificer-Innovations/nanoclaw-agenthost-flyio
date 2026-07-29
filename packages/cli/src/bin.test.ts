import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agenthostsOk, writeFixture } from "./agenthosts.test.js";
import { sessionioOk } from "./sessionio.test.js";
import { isCliEntry, main, parseArgs, runCommand } from "./bin.js";
import * as install from "./install.js";
import {
  findNanoclawRoot,
  hostSrcDir,
  packageRoot,
  readPackageVersion,
  resourcesDir,
  runnerResourcesDir,
  skillDir,
} from "./paths.js";

function seedFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "ahf-bin-"));
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
  return root;
}

describe("bin", () => {
  let root: string;
  afterEach(() => {
    vi.restoreAllMocks();
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("parseArgs reads command and --path", () => {
    expect(parseArgs(["node", "bin.js", "verify", "--path", "/tmp/x"])).toEqual(
      {
        command: "verify",
        path: "/tmp/x",
      },
    );
    expect(parseArgs(["node", "bin.js"]).command).toBe("help");
  });

  it("runCommand help returns 0", () => {
    expect(runCommand(["node", "bin.js", "help"])).toBe(0);
  });

  it("runCommand unknown returns 1", () => {
    expect(runCommand(["node", "bin.js", "nope"])).toBe(1);
  });

  it("isCliEntry compares paths safely", () => {
    expect(isCliEntry("/no/such", ["node"])).toBe(false);
    const self = fileURLToPath(import.meta.url);
    expect(isCliEntry(self, ["node", self])).toBe(true);
    expect(isCliEntry("/missing-a", ["node", "/missing-a"])).toBe(true);
  });

  it("main exits with runCommand status", () => {
    const exit = vi.spyOn(process, "exit").mockImplementation(((
      code?: number,
    ) => {
      throw new Error(`exit:${code ?? 0}`);
    }) as never);
    const prev = process.argv;
    process.argv = ["node", "bin.js", "help"];
    try {
      expect(() => main()).toThrow(/exit:0/);
    } finally {
      process.argv = prev;
      exit.mockRestore();
    }
  });

  it("runCommand prints non-Error throws", () => {
    vi.spyOn(install, "runInstall").mockImplementation(() => {
      throw "raw-failure";
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runCommand(["node", "bin.js", "install", "--path", "/tmp"])).toBe(1);
    expect(err).toHaveBeenCalledWith("raw-failure");
  });

  it("install / verify / sync-skill / uninstall via runCommand", () => {
    root = seedFixture();
    expect(runCommand(["node", "bin.js", "install", "--path", root])).toBe(0);
    expect(runCommand(["node", "bin.js", "upgrade", "--path", root])).toBe(0);
    expect(runCommand(["node", "bin.js", "verify", "--path", root])).toBe(0);
    expect(runCommand(["node", "bin.js", "sync-skill", "--path", root])).toBe(
      0,
    );
    expect(runCommand(["node", "bin.js", "uninstall", "--path", root])).toBe(0);
  });

  it("verify returns 1 on failure", () => {
    root = seedFixture();
    rmSync(path.join(root, "src/agenthosts.ts"));
    expect(runCommand(["node", "bin.js", "verify", "--path", root])).toBe(1);
  });

  it("sync-skill without --path uses findNanoclawRoot from cwd", () => {
    root = seedFixture();
    const prev = process.cwd();
    process.chdir(root);
    try {
      expect(runCommand(["node", "bin.js", "sync-skill"])).toBe(0);
    } finally {
      process.chdir(prev);
    }
  });
});

describe("paths", () => {
  it("resolves package root and resources", () => {
    const root = packageRoot();
    expect(existsSync(path.join(root, "package.json"))).toBe(true);
    expect(readPackageVersion()).toMatch(/^\d+\.\d+\.\d+/);
    expect(resourcesDir()).toContain("packages/host/src");
    expect(runnerResourcesDir()).toContain("packages/runner/src");
    expect(skillDir()).toContain("add-agenthost-flyio");
    expect(hostSrcDir()).toContain("packages/host/src");
  });

  it("findNanoclawRoot throws outside a fork", () => {
    const orphan = mkdtempSync(path.join(tmpdir(), "ahf-orphan-"));
    try {
      expect(() => findNanoclawRoot(orphan)).toThrow(/NanoClaw root not found/);
    } finally {
      rmSync(orphan, { recursive: true, force: true });
    }
  });

  it("findNanoclawRoot walks up to a fork", () => {
    const root = mkdtempSync(path.join(tmpdir(), "ahf-nc-root-"));
    try {
      mkdirSync(path.join(root, "src/channels"), { recursive: true });
      writeFileSync(path.join(root, "src/channels/index.ts"), "export {};\n");
      writeFileSync(path.join(root, "src/index.ts"), "export {};\n");
      const nested = path.join(root, "a", "b");
      mkdirSync(nested, { recursive: true });
      expect(findNanoclawRoot(nested)).toBe(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
