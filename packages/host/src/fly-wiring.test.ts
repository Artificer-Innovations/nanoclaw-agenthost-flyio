import { describe, expect, it } from "vitest";
import { startAgenthostFlyio } from "./fly-boot.js";
import { flyDriver, FLY_RUNTIME_NAME } from "./fly-runtime.js";

describe("fly wiring", () => {
  it("exports boot and driver", () => {
    expect(typeof startAgenthostFlyio).toBe("function");
    expect(FLY_RUNTIME_NAME).toBe("fly");
    expect(flyDriver.requiredTransport).toBe("http");
    expect(typeof flyDriver.wake).toBe("function");
  });
});
