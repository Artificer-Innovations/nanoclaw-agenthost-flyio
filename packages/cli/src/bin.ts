#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  printInstallNextSteps,
  runInstall,
  runUninstall,
  runUpgrade,
  runVerify,
} from "./install.js";
import { syncSkillToFork } from "./patch.js";
import { findNanoclawRoot } from "./paths.js";
import { runTeardown } from "./teardown.js";

const USAGE = `Usage: nanoclaw-agenthost-flyio <command> [--path <nanoclaw-root>]

Commands:
  install      Require agenthosts + sessionio, copy driver/runner files, patch boot
  upgrade      Re-copy + re-patch (idempotent install)
  sync-skill   Copy bundled skill to .claude/skills/add-agenthost-flyio/
  verify       Check peers, files, and markers
  teardown     Destroy Fly Machines + volumes for all .fly-machine.json identities
  uninstall    Remove files/boot block, then teardown remote Fly resources
`;

function parseArgs(argv: string[]): { command: string; path?: string } {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  let pathArg: string | undefined;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--path" && args[i + 1]) {
      pathArg = args[i + 1];
      i += 1;
    }
  }
  return { command, path: pathArg };
}

function printTeardownSummary(
  label: string,
  result: Awaited<ReturnType<typeof runTeardown>>,
): void {
  console.log(
    `${label}: app=${result.app} machinesDeleted=${result.machinesDeleted} volumesDeleted=${result.volumesDeleted} errors=${result.errors}`,
  );
  for (const row of result.sessions) {
    if (row.error) {
      console.error(`  - ${row.sessionDir}: ${row.error}`);
    }
  }
}

export async function runCommand(argv: string[]): Promise<number> {
  const { command, path: pathArg } = parseArgs(argv);

  try {
    switch (command) {
      case "install": {
        const result = runInstall(pathArg);
        printInstallNextSteps(result);
        return 0;
      }
      case "upgrade": {
        const result = runUpgrade(pathArg);
        printInstallNextSteps(result, { upgraded: true });
        return 0;
      }
      case "sync-skill": {
        const root = pathArg ?? findNanoclawRoot();
        const dest = syncSkillToFork(root);
        console.log(`Synced skill → ${dest}`);
        return 0;
      }
      case "verify": {
        const result = runVerify(pathArg);
        if (!result.ok) {
          console.error("Verification failed:");
          for (const issue of result.issues) console.error(`  - ${issue}`);
          return 1;
        }
        console.log(`Verification passed for ${result.root}`);
        return 0;
      }
      case "teardown": {
        const result = await runTeardown(pathArg);
        printTeardownSummary("Teardown", result);
        return result.errors > 0 ? 1 : 0;
      }
      case "uninstall": {
        const result = runUninstall(pathArg);
        console.log(`Removed agenthost-flyio from ${result.root}`);
        console.log(
          `Changed ${result.changed.length} files; deleted ${result.removed.length} files.`,
        );
        try {
          const td = await runTeardown(pathArg ?? result.root);
          printTeardownSummary("Remote Fly teardown", td);
        } catch (error) {
          console.error(
            `Remote Fly teardown skipped/failed: ${
              /* v8 ignore next -- non-Error throws */
              error instanceof Error ? error.message : String(error)
            }`,
          );
          console.error(
            "Destroy billed resources manually — see REMOVE.md (fly machines/volumes destroy).",
          );
        }
        console.log(
          "\nSee .claude/skills/add-agenthost-flyio/REMOVE.md if present.",
        );
        console.log("Optional: pnpm remove nanoclaw-agenthost-flyio");
        console.log(
          "Then: pnpm run build && rebuild agent image && restart host",
        );
        return 0;
      }
      case "help":
      case "--help":
      case "-h":
        console.log(USAGE);
        return 0;
      default:
        console.log(USAGE);
        return 1;
    }
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    return 1;
  }
}

export { parseArgs };

export function isCliEntry(entryPath: string, argv: string[]): boolean {
  if (!argv[1]) return false;
  try {
    return realpathSync(entryPath) === realpathSync(path.resolve(argv[1]));
  } catch {
    return entryPath === argv[1];
  }
}

async function main(): Promise<void> {
  process.exit(await runCommand(process.argv));
}

export { main };

/* v8 ignore start */
if (isCliEntry(fileURLToPath(import.meta.url), process.argv)) {
  void main();
}
/* v8 ignore stop */
