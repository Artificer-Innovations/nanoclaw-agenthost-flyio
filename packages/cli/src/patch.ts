import fs from "node:fs";
import path from "node:path";
import {
  FLY_BOOT_BLOCK,
  FLY_MARKER,
  HOST_COPY_RULES,
  HOST_OPTIONAL_COPY_RULES,
  RUNNER_COPY_RULES,
  RUNNER_OPTIONAL_COPY_RULES,
  resourcesDir,
  runnerResourcesDir,
  skillDir,
  type CopyRule,
} from "./paths.js";

const BOOT_BEGIN = `// ${FLY_MARKER}:boot:begin`;
const BOOT_END = `// ${FLY_MARKER}:boot:end`;

export function hasFlyBootBlock(content: string): boolean {
  return (
    content.includes(BOOT_BEGIN) && content.includes("startAgenthostFlyio")
  );
}

export function findFlyBootInsertIndex(content: string): number {
  const afterSessionio = content.match(
    /^[ \t]*\/\/ @nanoclaw-sessionio:index-boot:end\r?\n/m,
  );
  if (afterSessionio?.index != null) {
    return afterSessionio.index + afterSessionio[0].length;
  }

  const afterProcess = content.match(
    /^[ \t]*\/\/ @nanoclaw-agenthost-process:boot:end\r?\n/m,
  );
  if (afterProcess?.index != null) {
    return afterProcess.index + afterProcess[0].length;
  }

  const afterAdmin = content.match(/^[ \t]*await startAdminApi\(\);\r?\n/m);
  if (afterAdmin?.index != null) return afterAdmin.index + afterAdmin[0].length;

  const afterCli = content.match(/^[ \t]*await startCliServer\(\);\r?\n/m);
  if (afterCli?.index != null) return afterCli.index + afterCli[0].length;

  const afterAgenthosts = content.match(
    /^[ \t]*\/\/ @nanoclaw-agenthosts:boot:end\r?\n/m,
  );
  if (afterAgenthosts?.index != null) {
    return afterAgenthosts.index + afterAgenthosts[0].length;
  }

  const awaited = content.match(/^\s+await initChannelAdapters\(/m);
  if (awaited?.index != null) return awaited.index;

  const plain = content.match(/^\s+initChannelAdapters\(/m);
  if (plain?.index != null) return plain.index;

  return -1;
}

export function insertFlyBootBlockContent(content: string): string {
  if (hasFlyBootBlock(content)) return content;
  const idx = findFlyBootInsertIndex(content);
  if (idx < 0) {
    throw new Error("Could not find boot insert point in src/index.ts");
  }
  return `${content.slice(0, idx)}\n${FLY_BOOT_BLOCK}\n${content.slice(idx)}`;
}

export function removeFlyBootBlockContent(content: string): string {
  const pattern =
    /\r?\n?[ \t]*\/\/ @nanoclaw-agenthost-flyio:boot:begin\r?\n[\s\S]*?[ \t]*\/\/ @nanoclaw-agenthost-flyio:boot:end\r?\n?/;
  return content.replace(pattern, "\n");
}

export interface FileTransform {
  path: string;
  transform: (source: string) => string;
  uninstall: (source: string) => string;
  verify?: (source: string) => boolean;
}

export const FILE_TRANSFORMS: FileTransform[] = [
  {
    path: "src/index.ts",
    transform: insertFlyBootBlockContent,
    uninstall: removeFlyBootBlockContent,
    verify: hasFlyBootBlock,
  },
];

export function syncSkillToFork(
  nanoclawRoot: string,
  source: string = skillDir(),
): string {
  const destination = path.join(
    nanoclawRoot,
    ".claude/skills/add-agenthost-flyio",
  );
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  copyDirectory(source, destination);
  return destination;
}

export function resolveCopySources(
  nanoclawRoot: string,
  rules: CopyRule[],
  optional = false,
  kind: "host" | "runner" = "host",
): { rule: CopyRule; absoluteSource: string }[] {
  const resources =
    kind === "runner"
      ? runnerResourcesDir(undefined, nanoclawRoot)
      : resourcesDir(undefined, nanoclawRoot);
  const resolved: { rule: CopyRule; absoluteSource: string }[] = [];
  for (const rule of rules) {
    const absoluteSource = path.join(resources, rule.source);
    if (!fs.existsSync(absoluteSource)) {
      if (optional) continue;
      throw new Error(
        `Missing bundled resource: ${rule.source}. Run pnpm run build.`,
      );
    }
    resolved.push({ rule, absoluteSource });
  }
  return resolved;
}

export {
  HOST_COPY_RULES,
  HOST_OPTIONAL_COPY_RULES,
  RUNNER_COPY_RULES,
  RUNNER_OPTIONAL_COPY_RULES,
};

function copyDirectory(source: string, destination: string): void {
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory())
    fs.rmSync(destination, { force: true });
  fs.mkdirSync(destination, { recursive: true });
  for (const entry of fs.readdirSync(destination)) {
    fs.rmSync(path.join(destination, entry), { recursive: true, force: true });
  }
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(destination, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else fs.copyFileSync(from, to);
  }
}
