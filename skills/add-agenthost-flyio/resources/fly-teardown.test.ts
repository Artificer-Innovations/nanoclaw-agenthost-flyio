import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFlyIdentity } from "./fly-identity.js";
import { FlyMachinesClient } from "./fly-machines.js";
import { teardownAllFlySessions, teardownFlySession } from "./fly-teardown.js";

describe("fly-teardown", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("destroys machine + volume and clears identity", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-"));
    const sessionDir = path.join(dir, "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFlyIdentity(sessionDir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img",
    });

    const deleted: string[] = [];
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async (url: string, init?: RequestInit) => {
        deleted.push(`${init?.method} ${url}`);
        return new Response(null, { status: 204 });
      },
      sleep: async () => {},
    });

    const result = await teardownFlySession(sessionDir, client);
    expect(result.machineDeleted).toBe(true);
    expect(result.volumeDeleted).toBe(true);
    expect(result.identityCleared).toBe(true);
    expect(existsSync(path.join(sessionDir, ".fly-machine.json"))).toBe(false);
    expect(deleted.some((d) => d.includes("/machines/m1"))).toBe(true);
    expect(deleted.some((d) => d.includes("/volumes/v1"))).toBe(true);
  });

  it("treats 404 as already deleted", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-404-"));
    const sessionDir = path.join(dir, "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFlyIdentity(sessionDir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async () => new Response("gone", { status: 404 }),
      sleep: async () => {},
    });
    const result = await teardownFlySession(sessionDir, client);
    expect(result.machineDeleted).toBe(true);
    expect(result.volumeDeleted).toBe(true);
    expect(result.identityCleared).toBe(true);
  });

  it("teardownAllFlySessions walks v2-sessions", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-all-"));
    const sessionDir = path.join(dir, "data", "v2-sessions", "ag", "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFlyIdentity(sessionDir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async () => new Response(null, { status: 204 }),
      sleep: async () => {},
    });
    const result = await teardownAllFlySessions(dir, { client });
    expect(result.machinesDeleted).toBe(1);
    expect(result.volumesDeleted).toBe(1);
  });

  it("records errors without throwing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-err-"));
    const sessionDir = path.join(dir, "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFlyIdentity(sessionDir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async () => new Response("nope", { status: 500 }),
      sleep: async () => {},
      maxRetries: 0,
    });
    const result = await teardownFlySession(sessionDir, client);
    expect(result.error).toMatch(/500/);
    expect(result.identityCleared).toBe(false);
  });

  it("records volume delete failures after machine delete succeeds", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-volerr-"));
    const sessionDir = path.join(dir, "sess");
    mkdirSync(sessionDir, { recursive: true });
    writeFlyIdentity(sessionDir, {
      machineId: "m1",
      volumeId: "v1",
      app: "agents",
      region: "iad",
      image: "img",
    });
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl: async (url: string) => {
        if (url.includes("/machines/"))
          return new Response(null, { status: 204 });
        return new Response("vol busy", { status: 409 });
      },
      sleep: async () => {},
      maxRetries: 0,
    });
    const result = await teardownFlySession(sessionDir, client);
    expect(result.machineDeleted).toBe(true);
    expect(result.volumeDeleted).toBe(false);
    expect(result.error).toMatch(/409/);
  });

  it("no-ops when identity missing", async () => {
    dir = mkdtempSync(path.join(tmpdir(), "fly-td-miss-"));
    const fetchImpl = vi.fn();
    const client = new FlyMachinesClient({
      token: "t",
      app: "agents",
      fetchImpl,
      sleep: async () => {},
    });
    const result = await teardownFlySession(dir, client);
    expect(result.machineDeleted).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
