import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearFlyIdentity,
  identityPath,
  readFlyIdentity,
  writeFlyIdentity,
} from "./fly-identity.js";

describe("fly-identity", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips identity", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-id-"));
    writeFlyIdentity(dir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img:latest",
    });
    expect(identityPath(dir)).toContain(".fly-machine.json");
    const got = readFlyIdentity(dir);
    expect(got?.machineId).toBe("m1");
    expect(got?.updatedAt).toBeTruthy();
    const raw = JSON.parse(readFileSync(identityPath(dir), "utf8"));
    expect(raw.image).toBe("img:latest");
  });

  it("returns null when missing or invalid", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-id-miss-"));
    expect(readFlyIdentity(dir)).toBeNull();
    writeFileSync(identityPath(dir), "{not-json");
    expect(readFlyIdentity(dir)).toBeNull();
    writeFileSync(identityPath(dir), JSON.stringify({ machineId: "only" }));
    expect(readFlyIdentity(dir)).toBeNull();
  });

  it("writes identity atomically via tmp + rename", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-id-atomic-"));
    writeFlyIdentity(dir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img:latest",
    });
    const entries = readdirSync(dir);
    expect(entries.filter((e) => e.endsWith(".tmp"))).toEqual([]);
    expect(entries).toContain(".fly-machine.json");
    expect(readFlyIdentity(dir)?.machineId).toBe("m1");
  });

  it("clears identity file", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-id-clear-"));
    mkdirSync(dir, { recursive: true });
    writeFlyIdentity(dir, {
      machineId: "m1",
      volumeId: "v1",
      app: "a",
      region: "iad",
      image: "i",
    });
    clearFlyIdentity(dir);
    expect(readFlyIdentity(dir)).toBeNull();
    clearFlyIdentity(dir);
  });

  it("preserves string updatedAt and rejects non-string", () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-id-at-"));
    writeFileSync(
      identityPath(dir),
      JSON.stringify({
        machineId: "m",
        volumeId: "v",
        app: "a",
        region: "iad",
        image: "i",
        updatedAt: "2020-01-01T00:00:00.000Z",
      }),
    );
    expect(readFlyIdentity(dir)?.updatedAt).toBe("2020-01-01T00:00:00.000Z");
    writeFileSync(
      identityPath(dir),
      JSON.stringify({
        machineId: "m",
        volumeId: "v",
        app: "a",
        region: "iad",
        image: "i",
        updatedAt: 123,
      }),
    );
    expect(readFlyIdentity(dir)?.updatedAt).toBeUndefined();
  });
});
