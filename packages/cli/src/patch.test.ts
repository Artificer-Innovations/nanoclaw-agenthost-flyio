import { describe, expect, it } from "vitest";
import {
  findFlyBootInsertIndex,
  hasFlyBootBlock,
  insertFlyBootBlockContent,
  removeFlyBootBlockContent,
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
