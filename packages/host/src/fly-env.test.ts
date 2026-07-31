import { describe, expect, it } from "vitest";
import { applyFlyHostEnvFromFile, FLY_HOST_ENV_KEYS } from "./fly-env.js";

describe("applyFlyHostEnvFromFile", () => {
  it("exports host env keys", () => {
    expect(FLY_HOST_ENV_KEYS).toContain("NANOCLAW_ALLOW_FLY_RUNTIME");
    expect(FLY_HOST_ENV_KEYS).toContain("FLY_API_TOKEN");
  });

  it("applies missing keys from file", () => {
    const env: NodeJS.ProcessEnv = {};
    applyFlyHostEnvFromFile(env, () => ({
      NANOCLAW_ALLOW_FLY_RUNTIME: "1",
      FLY_API_TOKEN: " tok ",
    }));
    expect(env.NANOCLAW_ALLOW_FLY_RUNTIME).toBe("1");
    expect(env.FLY_API_TOKEN).toBe("tok");
  });

  it("does not overwrite existing env", () => {
    const env: NodeJS.ProcessEnv = { FLY_API_TOKEN: "existing" };
    applyFlyHostEnvFromFile(env, () => ({ FLY_API_TOKEN: "file" }));
    expect(env.FLY_API_TOKEN).toBe("existing");
  });

  it("uses default empty readFile", () => {
    const env: NodeJS.ProcessEnv = {};
    applyFlyHostEnvFromFile(env);
    expect(env.FLY_API_TOKEN).toBeUndefined();
  });
});
