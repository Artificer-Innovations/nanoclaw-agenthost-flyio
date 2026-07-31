import { describe, expect, it } from "vitest";
import {
  FLY_IDENTITY_FILENAME,
  FLY_REQUIRED_TRANSPORT,
  FLY_RUNTIME_NAME,
  isFlyRuntimeAllowed,
} from "./index.js";

describe("shared constants", () => {
  it("exports stable runtime contract names", () => {
    expect(FLY_RUNTIME_NAME).toBe("fly");
    expect(FLY_REQUIRED_TRANSPORT).toBe("http");
    expect(FLY_IDENTITY_FILENAME).toBe(".fly-machine.json");
  });

  it("isFlyRuntimeAllowed parses truthy opt-in", () => {
    expect(isFlyRuntimeAllowed({ NANOCLAW_ALLOW_FLY_RUNTIME: "1" })).toBe(true);
    expect(isFlyRuntimeAllowed({ NANOCLAW_ALLOW_FLY_RUNTIME: "true" })).toBe(
      true,
    );
    expect(isFlyRuntimeAllowed({ NANOCLAW_ALLOW_FLY_RUNTIME: "yes" })).toBe(
      true,
    );
    expect(isFlyRuntimeAllowed({ NANOCLAW_ALLOW_FLY_RUNTIME: "0" })).toBe(
      false,
    );
    expect(isFlyRuntimeAllowed({})).toBe(false);
  });
});
