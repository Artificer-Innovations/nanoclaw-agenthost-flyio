import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function packageRoot(startDir: string = __dirname): string {
  let dir = startDir;
  for (;;) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
        name?: string;
      };
      if (pkg.name === "nanoclaw-agenthost-flyio") return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error("Could not locate nanoclaw-agenthost-flyio package root");
}

export function skillDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), "skills/add-agenthost-flyio");
}

export function hostSrcDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), "packages/host/src");
}

export function runnerSrcDir(startDir: string = __dirname): string {
  return path.join(packageRoot(startDir), "packages/runner/src");
}

export function resourcesDir(
  startDir: string = __dirname,
  nanoclawRoot?: string,
): string {
  const hostSrc = hostSrcDir(startDir);
  if (fs.existsSync(path.join(hostSrc, "fly-boot.ts"))) {
    return hostSrc;
  }
  if (nanoclawRoot) {
    const linked = resolveLinkedHostSrc(nanoclawRoot);
    if (linked) return linked;
  }
  return path.join(skillDir(startDir), "resources");
}

export function runnerResourcesDir(
  startDir: string = __dirname,
  nanoclawRoot?: string,
): string {
  const runnerSrc = runnerSrcDir(startDir);
  if (fs.existsSync(path.join(runnerSrc, "workspace.ts"))) {
    return runnerSrc;
  }
  if (nanoclawRoot) {
    const linkedRoot = resolveLinkedRoot(nanoclawRoot);
    if (linkedRoot) {
      const linked = path.join(linkedRoot, "packages/runner/src");
      if (fs.existsSync(path.join(linked, "workspace.ts"))) return linked;
    }
  }
  return path.join(skillDir(startDir), "resources/runner");
}

function resolveLinkedRoot(nanoclawRoot: string): string | null {
  const pkgPath = path.join(nanoclawRoot, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const dep =
    pkg.dependencies?.["nanoclaw-agenthost-flyio"] ??
    pkg.devDependencies?.["nanoclaw-agenthost-flyio"];
  if (!dep?.startsWith("file:")) return null;
  return path.resolve(nanoclawRoot, dep.slice("file:".length));
}

function resolveLinkedHostSrc(nanoclawRoot: string): string | null {
  const linkedRoot = resolveLinkedRoot(nanoclawRoot);
  if (!linkedRoot) return null;
  const hostSrc = path.join(linkedRoot, "packages/host/src");
  return fs.existsSync(path.join(hostSrc, "fly-boot.ts")) ? hostSrc : null;
}

export interface CopyRule {
  source: string;
  dest: string;
}

export const HOST_COPY_RULES: CopyRule[] = [
  { source: "fly-shared.ts", dest: "src/fly-shared.ts" },
  { source: "fly-boot.ts", dest: "src/fly-boot.ts" },
  { source: "fly-env.ts", dest: "src/fly-env.ts" },
  { source: "fly-identity.ts", dest: "src/fly-identity.ts" },
  { source: "fly-machines.ts", dest: "src/fly-machines.ts" },
  { source: "fly-onecli.ts", dest: "src/fly-onecli.ts" },
  { source: "fly-transport.ts", dest: "src/fly-transport.ts" },
  { source: "fly-runtime.ts", dest: "src/fly-runtime.ts" },
  { source: "fly-teardown.ts", dest: "src/fly-teardown.ts" },
];

export const HOST_OPTIONAL_COPY_RULES: CopyRule[] = [
  { source: "fly-boot.test.ts", dest: "src/fly-boot.test.ts" },
  { source: "fly-env.test.ts", dest: "src/fly-env.test.ts" },
  { source: "fly-identity.test.ts", dest: "src/fly-identity.test.ts" },
  { source: "fly-machines.test.ts", dest: "src/fly-machines.test.ts" },
  { source: "fly-onecli.test.ts", dest: "src/fly-onecli.test.ts" },
  { source: "fly-transport.test.ts", dest: "src/fly-transport.test.ts" },
  { source: "fly-runtime.test.ts", dest: "src/fly-runtime.test.ts" },
  { source: "fly-teardown.test.ts", dest: "src/fly-teardown.test.ts" },
  { source: "fly-wiring.test.ts", dest: "src/fly-wiring.test.ts" },
];

export const RUNNER_COPY_RULES: CopyRule[] = [
  {
    source: "workspace.ts",
    dest: "container/agent-runner/src/fly/workspace.ts",
  },
  {
    source: "register.ts",
    dest: "container/agent-runner/src/fly/register.ts",
  },
];

export const RUNNER_OPTIONAL_COPY_RULES: CopyRule[] = [
  {
    source: "workspace.test.ts",
    dest: "container/agent-runner/src/fly/workspace.test.ts",
  },
  {
    source: "register.test.ts",
    dest: "container/agent-runner/src/fly/register.test.ts",
  },
];

export const FLY_BOOT_BLOCK = `  // @nanoclaw-agenthost-flyio:boot:begin
  const { startAgenthostFlyio } = await import('./fly-boot.js');
  startAgenthostFlyio();
  // @nanoclaw-agenthost-flyio:boot:end`;

export const FLY_MARKER = "@nanoclaw-agenthost-flyio";

export const REQUIRED_HOST_FILES = HOST_COPY_RULES.map((r) => r.dest);
export const REQUIRED_RUNNER_FILES = RUNNER_COPY_RULES.map((r) => r.dest);

export function findNanoclawRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    const channelsIndex = path.join(dir, "src/channels/index.ts");
    const hostIndex = path.join(dir, "src/index.ts");
    if (fs.existsSync(channelsIndex) && fs.existsSync(hostIndex)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    "NanoClaw root not found (expected src/channels/index.ts and src/index.ts). Use --path.",
  );
}

export function readPackageVersion(): string {
  const pkgPath = path.join(packageRoot(), "package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    version?: string;
  };
  return pkg.version ?? "0.0.0";
}
