/**
 * Volume workspace bootstrap for Fly agent Machines.
 * Mailbox IO stays on sessionio HTTP peer — this only prepares /workspace.
 *
 * Guest files cannot be injected directly under the volume mount path
 * (`/workspace/...`): Fly writes them before mount, then the volume hides them.
 * Host injects bootstrap into `/etc/nanoclaw/agent/`; we copy onto the volume.
 */
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

export const DEFAULT_WORKING_ROOT = "/workspace";
export const FLY_AGENT_BOOTSTRAP_DIR = "/etc/nanoclaw/agent";

export interface EnsureFlyWorkspaceOpts {
  workingRoot?: string;
  groupFolder?: string;
  bootstrapDir?: string;
  mkdir?: typeof fs.mkdirSync;
  copyFile?: typeof fs.copyFileSync;
  readdir?: typeof fs.readdirSync;
  exists?: typeof fs.existsSync;
}

const require = createRequire(import.meta.url);

function ensurePeerSqliteFiles(root: string): void {
  const inboundPath = path.join(root, "inbound.db");
  const outboundPath = path.join(root, "outbound.db");

  type SqliteDb = {
    exec: (sql: string) => void;
    close: () => void;
  };
  type SqliteDatabaseCtor = new (filename: string) => SqliteDb;

  let Database: SqliteDatabaseCtor | null = null;
  try {
    Database = require("bun:sqlite").Database as SqliteDatabaseCtor;
  } catch {
    // Vitest/Node has no bun:sqlite — placeholders are enough for unit tests.
    for (const filePath of [inboundPath, outboundPath]) {
      if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "");
    }
    return;
  }

  // Always ensure schema — volumes persist stub tables from older images.
  {
    const db = new Database(inboundPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_routing (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        channel_type TEXT,
        platform_id TEXT,
        thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS destinations (
        name TEXT PRIMARY KEY,
        display_name TEXT,
        type TEXT,
        channel_type TEXT,
        platform_id TEXT,
        agent_group_id TEXT
      );
      CREATE TABLE IF NOT EXISTS messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT,
        timestamp      TEXT,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        series_id      TEXT,
        tries          INTEGER DEFAULT 0,
        trigger        INTEGER NOT NULL DEFAULT 1,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL DEFAULT '',
        on_wake        INTEGER NOT NULL DEFAULT 0
      );
    `);
    const cols = new Set(
      (
        db.prepare("PRAGMA table_info('messages_in')").all() as Array<{
          name: string;
        }>
      ).map((c) => c.name),
    );
    const addIfMissing: Array<[string, string]> = [
      ["seq", "INTEGER"],
      ["kind", "TEXT"],
      ["timestamp", "TEXT"],
      ["status", "TEXT"],
      ["process_after", "TEXT"],
      ["recurrence", "TEXT"],
      ["series_id", "TEXT"],
      ["tries", "INTEGER DEFAULT 0"],
      ["trigger", "INTEGER NOT NULL DEFAULT 1"],
      ["platform_id", "TEXT"],
      ["channel_type", "TEXT"],
      ["thread_id", "TEXT"],
      ["content", "TEXT NOT NULL DEFAULT ''"],
      ["on_wake", "INTEGER NOT NULL DEFAULT 0"],
    ];
    for (const [name, ddl] of addIfMissing) {
      if (!cols.has(name)) {
        db.exec(`ALTER TABLE messages_in ADD COLUMN ${name} ${ddl}`);
      }
    }
    db.close();
  }

  if (!fs.existsSync(outboundPath)) {
    const db = new Database(outboundPath);
    db.exec("PRAGMA journal_mode = DELETE");
    db.exec(`
      CREATE TABLE IF NOT EXISTS messages_out (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        in_reply_to    TEXT,
        timestamp      TEXT NOT NULL,
        deliver_after  TEXT,
        recurrence     TEXT,
        kind           TEXT NOT NULL,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS processing_ack (
        message_id     TEXT PRIMARY KEY,
        status         TEXT NOT NULL,
        status_changed TEXT NOT NULL
      );
    `);
    db.close();
  }
}

function copyBootstrapAgentFiles(
  agentDir: string,
  bootstrapDir: string,
  opts: EnsureFlyWorkspaceOpts,
): void {
  const exists = opts.exists ?? fs.existsSync;
  const readdir = opts.readdir ?? fs.readdirSync;
  const copyFile = opts.copyFile ?? fs.copyFileSync;
  if (!exists(bootstrapDir)) return;
  for (const name of readdir(bootstrapDir)) {
    const src = path.join(bootstrapDir, name);
    const dest = path.join(agentDir, name);
    try {
      copyFile(src, dest);
    } catch {
      // best-effort
    }
  }
}

/**
 * Ensure memory / groups dirs exist on the attached volume.
 */
export function ensureFlyWorkspace(opts: EnsureFlyWorkspaceOpts = {}): string {
  const root =
    opts.workingRoot ?? process.env.WORKING_ROOT ?? DEFAULT_WORKING_ROOT;
  const mkdir = opts.mkdir ?? fs.mkdirSync;
  const groupFolder =
    opts.groupFolder ?? process.env.NANOCLAW_GROUP_FOLDER ?? "default";
  const bootstrapDir = opts.bootstrapDir ?? FLY_AGENT_BOOTSTRAP_DIR;

  mkdir(root, { recursive: true });
  const agentDir = path.join(root, "agent");
  mkdir(agentDir, { recursive: true });
  mkdir(path.join(root, "groups", groupFolder), { recursive: true });
  mkdir(path.join(root, "inbox"), { recursive: true });
  mkdir(path.join(root, "outbox"), { recursive: true });

  copyBootstrapAgentFiles(agentDir, bootstrapDir, opts);
  try {
    ensurePeerSqliteFiles(root);
  } catch {
    // Stub mkdir in unit tests; real Fly volumes are writable.
  }

  return root;
}

/** True when the runner should use sessionio remote peer mode. */
export function isFlyRemotePeerMode(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const transport = (env.SESSIONIO_TRANSPORT ?? "").trim().toLowerCase();
  const base = (env.SESSIONIO_BASE_URL ?? "").trim();
  return (
    Boolean(base) &&
    (transport === "http" || transport === "loopback" || !transport)
  );
}
