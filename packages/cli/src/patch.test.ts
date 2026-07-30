import { describe, expect, it } from "vitest";
import {
  findFlyBootInsertIndex,
  hasFlyBootBlock,
  hasFlyRunnerRegister,
  insertFlyBootBlockContent,
  insertFlyRunnerRegister,
  removeFlyBootBlockContent,
  removeFlyRunnerRegister,
  scavengeUnmarkedFlyRunnerRegister,
} from "./patch.js";

describe("patch boot block", () => {
  it("inserts after sessionio boot", () => {
    const source = `async function main() {
  // @nanoclaw-sessionio:index-boot:begin
  startSessionio();
  // @nanoclaw-sessionio:index-boot:end
  await initChannelAdapters();
}
`;
    const next = insertFlyBootBlockContent(source);
    expect(hasFlyBootBlock(next)).toBe(true);
    expect(insertFlyBootBlockContent(next)).toBe(next);
    const removed = removeFlyBootBlockContent(next);
    expect(hasFlyBootBlock(removed)).toBe(false);
  });

  it("finds insert points", () => {
    expect(findFlyBootInsertIndex("await startAdminApi();\n")).toBeGreaterThan(
      -1,
    );
    expect(findFlyBootInsertIndex("await startCliServer();\n")).toBeGreaterThan(
      -1,
    );
    expect(
      findFlyBootInsertIndex("// @nanoclaw-agenthosts:boot:end\n"),
    ).toBeGreaterThan(-1);
    expect(
      findFlyBootInsertIndex("// @nanoclaw-agenthost-process:boot:end\n"),
    ).toBeGreaterThan(-1);
    expect(
      findFlyBootInsertIndex("  initChannelAdapters();\n"),
    ).toBeGreaterThan(-1);
    expect(findFlyBootInsertIndex("nothing")).toBe(-1);
  });

  it("throws when no insert point", () => {
    expect(() => insertFlyBootBlockContent("no anchors")).toThrow(
      /boot insert point/,
    );
  });
});

describe("patch runner register", () => {
  it("inserts marked registerFlyRunner and uninstalls cleanly", () => {
    const source = `import './agenttrace/register.js';\n`;
    const next = insertFlyRunnerRegister(source);
    expect(hasFlyRunnerRegister(next)).toBe(true);
    expect(next).toContain("registerFlyRunner");
    expect(insertFlyRunnerRegister(next)).toBe(next);
    const removed = removeFlyRunnerRegister(next);
    expect(hasFlyRunnerRegister(removed)).toBe(false);
    expect(removed).not.toContain("registerFlyRunner");
    expect(removed).toContain("import './agenttrace/register.js';");
  });

  it("scavenges unmarked registerFlyRunner hotfixes on uninstall", () => {
    const unmarked = `import { registerFlyRunner } from './fly/register.js';
registerFlyRunner(process.env, {
  info: (msg) => console.error(\`[agent-runner] \${msg}\`),
  warn: (msg) => console.error(\`[agent-runner] \${msg}\`),
});
import './agenttrace/register.js';
`;
    expect(scavengeUnmarkedFlyRunnerRegister(unmarked)).not.toContain(
      "registerFlyRunner",
    );
    const cleaned = removeFlyRunnerRegister(unmarked);
    expect(cleaned).not.toContain("registerFlyRunner");
    expect(cleaned).toContain("import './agenttrace/register.js';");
  });
});
