import fs from "node:fs";
import path from "node:path";
import {
  FLY_IDENTITY_FILENAME,
  type FlyMachineIdentity,
} from "./fly-shared.js";

export { FLY_IDENTITY_FILENAME, type FlyMachineIdentity };

export function identityPath(sessionDirectory: string): string {
  return path.join(sessionDirectory, FLY_IDENTITY_FILENAME);
}

export function readFlyIdentity(
  sessionDirectory: string,
): FlyMachineIdentity | null {
  const file = identityPath(sessionDirectory);
  if (!fs.existsSync(file)) return null;
  try {
    const raw = JSON.parse(
      fs.readFileSync(file, "utf8"),
    ) as Partial<FlyMachineIdentity>;
    if (
      typeof raw.machineId !== "string" ||
      typeof raw.volumeId !== "string" ||
      typeof raw.app !== "string" ||
      typeof raw.region !== "string" ||
      typeof raw.image !== "string"
    ) {
      return null;
    }
    return {
      machineId: raw.machineId,
      volumeId: raw.volumeId,
      app: raw.app,
      region: raw.region,
      image: raw.image,
      updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
  } catch {
    return null;
  }
}

export function writeFlyIdentity(
  sessionDirectory: string,
  identity: FlyMachineIdentity,
): void {
  fs.mkdirSync(sessionDirectory, { recursive: true });
  const next: FlyMachineIdentity = {
    ...identity,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(
    identityPath(sessionDirectory),
    `${JSON.stringify(next, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export function clearFlyIdentity(sessionDirectory: string): void {
  const file = identityPath(sessionDirectory);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}
