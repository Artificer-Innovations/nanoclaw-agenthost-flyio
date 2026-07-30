import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { startAgenthostFlyio } from "./fly-boot.js";

const readEnvFile = vi.fn((_keys: string[]): Record<string, string> => ({}));

vi.mock("./env.js", () => ({
  readEnvFile: (keys: string[]) => readEnvFile(keys),
}));

describe("fly-boot", () => {
  const prev = process.env.NANOCLAW_ALLOW_FLY_RUNTIME;

  afterEach(() => {
    if (prev === undefined) delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    else process.env.NANOCLAW_ALLOW_FLY_RUNTIME = prev;
    readEnvFile.mockReset();
    readEnvFile.mockReturnValue({});
  });

  it("registers and warns when not allowed", () => {
    delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    startAgenthostFlyio();
  });

  it("registers and logs info when allowed", () => {
    process.env.NANOCLAW_ALLOW_FLY_RUNTIME = "1";
    startAgenthostFlyio();
  });

  it("applies allow flag from .env via readEnvFile", () => {
    delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    readEnvFile.mockReturnValue({ NANOCLAW_ALLOW_FLY_RUNTIME: "1" });
    startAgenthostFlyio();
    expect(process.env.NANOCLAW_ALLOW_FLY_RUNTIME).toBe("1");
  });
});
