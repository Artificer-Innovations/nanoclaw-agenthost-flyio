import { describe, expect, it } from "vitest";
import { registerFlyRunner } from "./register.js";

describe("register export", () => {
  it("is callable", () => {
    expect(typeof registerFlyRunner).toBe("function");
  });
});
