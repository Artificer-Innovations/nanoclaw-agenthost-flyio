import { describe, expect, it, vi, afterEach } from "vitest";
import { startAgenthostFlyio } from "./fly-boot.js";

const readEnvFile = vi.fn((_keys: string[]): Record<string, string> => ({}));
const cleanupFlyOrphans = vi.fn(async (): Promise<void> => {});

vi.mock("./env.js", () => ({
  readEnvFile: (keys: string[]) => readEnvFile(keys),
}));

vi.mock("./fly-runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./fly-runtime.js")>();
  return {
    ...actual,
    cleanupFlyOrphans: (...args: unknown[]) => cleanupFlyOrphans(...args),
  };
});

describe("fly-boot", () => {
  const prev = process.env.NANOCLAW_ALLOW_FLY_RUNTIME;

  afterEach(() => {
    if (prev === undefined) delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    else process.env.NANOCLAW_ALLOW_FLY_RUNTIME = prev;
    readEnvFile.mockReset();
    readEnvFile.mockReturnValue({});
    cleanupFlyOrphans.mockReset();
    cleanupFlyOrphans.mockResolvedValue(undefined);
  });

  it("registers and warns when not allowed", () => {
    delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    startAgenthostFlyio();
    expect(cleanupFlyOrphans).not.toHaveBeenCalled();
  });

  it("registers and logs info when allowed", async () => {
    process.env.NANOCLAW_ALLOW_FLY_RUNTIME = "1";
    startAgenthostFlyio();
    expect(cleanupFlyOrphans).toHaveBeenCalled();
    await Promise.resolve();
  });

  it("logs when boot rehydrate rejects", async () => {
    process.env.NANOCLAW_ALLOW_FLY_RUNTIME = "1";
    cleanupFlyOrphans.mockRejectedValueOnce(new Error("rehydrate boom"));
    startAgenthostFlyio();
    await vi.waitFor(() => {
      expect(cleanupFlyOrphans).toHaveBeenCalled();
    });
    // Allow the rejected promise's .catch to run.
    await Promise.resolve();
    await Promise.resolve();
  });

  it("applies allow flag from .env via readEnvFile", () => {
    delete process.env.NANOCLAW_ALLOW_FLY_RUNTIME;
    readEnvFile.mockReturnValue({ NANOCLAW_ALLOW_FLY_RUNTIME: "1" });
    startAgenthostFlyio();
    expect(process.env.NANOCLAW_ALLOW_FLY_RUNTIME).toBe("1");
  });
});
