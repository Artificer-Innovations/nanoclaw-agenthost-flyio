import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { agenthostsOk, writeFixture } from "./agenthosts.test.js";
import { sessionioOk } from "./sessionio.test.js";
import {
  printInstallNextSteps,
  runInstall,
  runUninstall,
  runUpgrade,
  runVerify,
} from "./install.js";

function fixtureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), "fly-install-"));
  agenthostsOk(root);
  sessionioOk(root);
  writeFixture(root, "src/channels/index.ts", "export {};\n");
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
  writeFixture(root, "container/agent-runner/src/index.ts", "export {};\n");
  writeFixture(
    root,
    "package.json",
    JSON.stringify({ name: "nanoclaw-fixture" }),
  );
  return root;
}

describe("install", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("installs verifies upgrades uninstalls", () => {
    root = fixtureRoot();
    const installed = runInstall(root);
    expect(installed.changed.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "src/fly-boot.ts"))).toBe(true);
    expect(
      existsSync(
        path.join(root, "container/agent-runner/src/fly/workspace.ts"),
      ),
    ).toBe(true);
    expect(runVerify(root).ok).toBe(true);

    const upgraded = runUpgrade(root);
    expect(upgraded.unchanged.length).toBeGreaterThan(0);
    printInstallNextSteps(upgraded, { upgraded: true });

    const removed = runUninstall(root);
    expect(removed.removed.length).toBeGreaterThan(0);
    expect(existsSync(path.join(root, "src/fly-boot.ts"))).toBe(false);
  });

  it("verify reports missing peers and files", () => {
    root = mkdtempSync(path.join(tmpdir(), "fly-verify-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "src/index.ts", "export {};\n");
    const result = runVerify(root);
    expect(result.ok).toBe(false);
    expect(result.issues.length).toBeGreaterThan(0);
  });

  it("install fails without peers", () => {
    root = mkdtempSync(path.join(tmpdir(), "fly-nopeer-"));
    writeFixture(root, "src/channels/index.ts", "export {};\n");
    writeFixture(root, "src/index.ts", "await initChannelAdapters();\n");
    expect(() => runInstall(root)).toThrow(/agenthosts/);
  });
});
