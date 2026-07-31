#!/usr/bin/env node
/**
 * Sync packages/shared → host fly-shared.ts, host/src → skill resources,
 * runner/src → skill resources/runner.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const sharedSrc = path.join(root, "packages/shared/src/index.ts");
const hostSrc = path.join(root, "packages/host/src");
const runnerSrc = path.join(root, "packages/runner/src");
const destHost = path.join(root, "skills/add-agenthost-flyio/resources");
const destRunner = path.join(destHost, "runner");

// Keep host fly-shared.ts aligned with shared package.
fs.copyFileSync(sharedSrc, path.join(hostSrc, "fly-shared.ts"));

fs.mkdirSync(destHost, { recursive: true });
for (const name of fs.readdirSync(destHost)) {
  if (name === "runner") continue;
  fs.rmSync(path.join(destHost, name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(hostSrc)) {
  if (!name.endsWith(".ts")) continue;
  fs.copyFileSync(path.join(hostSrc, name), path.join(destHost, name));
}

fs.mkdirSync(destRunner, { recursive: true });
for (const name of fs.readdirSync(destRunner)) {
  fs.rmSync(path.join(destRunner, name), { recursive: true, force: true });
}
for (const name of fs.readdirSync(runnerSrc)) {
  if (!name.endsWith(".ts")) continue;
  fs.copyFileSync(path.join(runnerSrc, name), path.join(destRunner, name));
}

console.log(
  `Synced shared+host+runner → ${path.relative(root, destHost)} (+ runner/)`,
);
