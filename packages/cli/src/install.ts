import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  agenthostsInstallGuidance,
  findAgenthostsIssues,
  requireAgenthosts,
} from "./agenthosts.js";
import {
  FILE_TRANSFORMS,
  HOST_COPY_RULES,
  HOST_OPTIONAL_COPY_RULES,
  RUNNER_COPY_RULES,
  RUNNER_OPTIONAL_COPY_RULES,
  resolveCopySources,
  syncSkillToFork,
} from "./patch.js";
import {
  REQUIRED_HOST_FILES,
  REQUIRED_RUNNER_FILES,
  findNanoclawRoot,
  readPackageVersion,
} from "./paths.js";
import {
  findSessionioIssues,
  requireSessionio,
  sessionioInstallGuidance,
} from "./sessionio.js";

interface PendingWrite {
  path: string;
  content: Buffer;
  previous: Buffer | null;
  mode: number | undefined;
}

export interface InstallResult {
  root: string;
  changed: string[];
  unchanged: string[];
  version: string;
  skillPath: string;
}

export function runInstall(root?: string): InstallResult {
  const nanoclawRoot = root ?? findNanoclawRoot();
  console.log(`Detected NanoClaw root: ${nanoclawRoot}`);
  requireAgenthosts(nanoclawRoot);
  requireSessionio(nanoclawRoot);

  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      throw new Error(`Missing required host file: ${file.path}`);
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    const next = file.transform(source);
    stageIfChanged(
      pending,
      unchanged,
      absolutePath,
      file.path,
      Buffer.from(next),
    );
  }

  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    HOST_COPY_RULES,
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }
  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    HOST_OPTIONAL_COPY_RULES,
    true,
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }
  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    RUNNER_COPY_RULES,
    false,
    "runner",
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }
  for (const { rule, absoluteSource } of resolveCopySources(
    nanoclawRoot,
    RUNNER_OPTIONAL_COPY_RULES,
    true,
    "runner",
  )) {
    stageIfChanged(
      pending,
      unchanged,
      path.join(nanoclawRoot, rule.dest),
      rule.dest,
      fs.readFileSync(absoluteSource),
    );
  }

  commitWrites(pending);
  const skillPath = syncSkillToFork(nanoclawRoot);

  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    unchanged,
    version: readPackageVersion(),
    skillPath,
  };
}

export function runUpgrade(root?: string): InstallResult {
  return runInstall(root);
}

export function runVerify(root?: string): {
  root: string;
  ok: boolean;
  issues: string[];
} {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const issues: string[] = [
    ...findAgenthostsIssues(nanoclawRoot).map(
      (issue) => `${issue}; ${agenthostsInstallGuidance()}`,
    ),
    ...findSessionioIssues(nanoclawRoot).map(
      (issue) => `${issue}; ${sessionioInstallGuidance()}`,
    ),
  ];

  for (const rel of [...REQUIRED_HOST_FILES, ...REQUIRED_RUNNER_FILES]) {
    if (!fs.existsSync(path.join(nanoclawRoot, rel))) {
      issues.push(`missing ${rel}`);
    }
  }

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) {
      issues.push(`missing ${file.path}`);
      continue;
    }
    const source = fs.readFileSync(absolutePath, "utf8");
    if (file.verify && !file.verify(source)) {
      issues.push(`${file.path} missing agenthost-flyio markers`);
    }
  }

  return { root: nanoclawRoot, ok: issues.length === 0, issues };
}

export function runUninstall(root?: string): {
  root: string;
  changed: string[];
  removed: string[];
} {
  const nanoclawRoot = root ?? findNanoclawRoot();
  const pending: PendingWrite[] = [];
  const unchanged: string[] = [];

  for (const file of FILE_TRANSFORMS) {
    const absolutePath = path.join(nanoclawRoot, file.path);
    if (!fs.existsSync(absolutePath)) continue;
    const source = fs.readFileSync(absolutePath, "utf8");
    const next = file.uninstall(source);
    stageIfChanged(
      pending,
      unchanged,
      absolutePath,
      file.path,
      Buffer.from(next),
    );
  }
  commitWrites(pending);

  const removed: string[] = [];
  for (const rule of [
    ...HOST_COPY_RULES,
    ...HOST_OPTIONAL_COPY_RULES,
    ...RUNNER_COPY_RULES,
    ...RUNNER_OPTIONAL_COPY_RULES,
  ]) {
    const target = path.join(nanoclawRoot, rule.dest);
    if (fs.existsSync(target)) {
      fs.unlinkSync(target);
      removed.push(rule.dest);
    }
  }

  const flyRunnerDir = path.join(
    nanoclawRoot,
    "container/agent-runner/src/fly",
  );
  if (fs.existsSync(flyRunnerDir)) {
    const leftover = fs.readdirSync(flyRunnerDir);
    if (leftover.length === 0) {
      fs.rmSync(flyRunnerDir, { recursive: true, force: true });
    }
  }

  const skillDest = path.join(
    nanoclawRoot,
    ".claude/skills/add-agenthost-flyio",
  );
  if (fs.existsSync(skillDest)) {
    fs.rmSync(skillDest, { recursive: true, force: true });
    removed.push(".claude/skills/add-agenthost-flyio");
  }

  return {
    root: nanoclawRoot,
    changed: pending.map((write) => path.relative(nanoclawRoot, write.path)),
    removed,
  };
}

export function printInstallNextSteps(
  result: InstallResult,
  options: { upgraded?: boolean } = {},
): void {
  console.log(
    `${options.upgraded ? "Upgraded" : "Installed"} nanoclaw-agenthost-flyio@${result.version} into ${result.root}`,
  );
  console.log(
    `Changed ${result.changed.length} files; ${result.unchanged.length} already current.`,
  );
  console.log(`Synced skill → ${result.skillPath}`);
  console.log("\nNext steps:");
  console.log(
    "  1. Set FLY_API_TOKEN, FLY_APP_AGENTS, FLY_AGENT_IMAGE, FLY_REGION",
  );
  console.log(
    "  2. Set SESSIONIO_TRANSPORT=http and a Fly-reachable SESSIONIO_BASE_URL / FLY_SESSIONIO_BASE_URL",
  );
  console.log("  3. pnpm run build && rebuild/publish the agent image");
  console.log("  4. pnpm exec nanoclaw-agenthost-flyio verify");
  console.log(
    "  5. Opt a group in: ncl groups config update --id <id> --runtime fly --session-transport http",
  );
  console.log("  6. Set NANOCLAW_ALLOW_FLY_RUNTIME=1 and restart the host");
}

function stageIfChanged(
  pending: PendingWrite[],
  unchanged: string[],
  absolutePath: string,
  relativePath: string,
  content: Buffer,
): void {
  const exists = fs.existsSync(absolutePath);
  const previous = exists ? fs.readFileSync(absolutePath) : null;
  if (previous?.equals(content)) {
    unchanged.push(relativePath);
    return;
  }
  pending.push({
    path: absolutePath,
    content,
    previous,
    mode: exists ? fs.statSync(absolutePath).mode : undefined,
  });
}

function commitWrites(writes: PendingWrite[]): void {
  const committed: PendingWrite[] = [];
  try {
    for (const write of writes) {
      atomicWrite(write.path, write.content, write.mode);
      committed.push(write);
    }
  } catch (error) {
    for (const write of committed.reverse()) {
      if (write.previous === null) fs.rmSync(write.path, { force: true });
      else atomicWrite(write.path, write.previous, write.mode);
    }
    throw error;
  }
}

function atomicWrite(target: string, content: Buffer, mode?: number): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temporary = `${target}.agenthost-flyio-${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(
      temporary,
      content,
      mode === undefined ? undefined : { mode },
    );
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
