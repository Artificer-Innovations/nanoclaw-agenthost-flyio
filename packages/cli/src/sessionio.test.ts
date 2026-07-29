import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPECTED_SESSIONIO_API_VERSION,
  findSessionioIssues,
  requireSessionio,
} from "./sessionio.js";
import { writeFixture } from "./agenthosts.test.js";

export function sessionioOk(root: string): void {
  writeFixture(
    root,
    "src/sessionio.ts",
    `export const SESSIONIO_API_VERSION = ${EXPECTED_SESSIONIO_API_VERSION} as const;\nexport function registerSessionTransport() {}\nexport function resolveSessionTransport() {}\n`,
  );
  writeFixture(
    root,
    "src/index.ts",
    `// @nanoclaw-sessionio:index-boot:begin\n// @nanoclaw-sessionio:index-boot:end\n`,
  );
}

describe("requireSessionio", () => {
  let root: string;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("passes when tokens are present", () => {
    root = mkdtempSync(path.join(tmpdir(), "sio-ok-"));
    sessionioOk(root);
    expect(findSessionioIssues(root)).toEqual([]);
    expect(() => requireSessionio(root)).not.toThrow();
  });

  it("fails when sessionio is missing", () => {
    root = mkdtempSync(path.join(tmpdir(), "sio-missing-"));
    mkdirSync(path.join(root, "src"), { recursive: true });
    expect(findSessionioIssues(root).length).toBeGreaterThan(0);
    expect(() => requireSessionio(root)).toThrow(/nanoclaw-sessionio API v1/);
  });
});
