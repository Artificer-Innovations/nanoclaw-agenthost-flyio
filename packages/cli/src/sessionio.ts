import fs from "node:fs";
import path from "node:path";

/** Pinned contract — keep in sync with nanoclaw-sessionio API version 1. */
export const EXPECTED_SESSIONIO_API_VERSION = 1 as const;

const INSTALL_GUIDANCE =
  "Install nanoclaw-sessionio@^0.1.0 (API v1) first — fly requires HTTP mailbox. " +
  "See https://github.com/Artificer-Innovations/nanoclaw-sessionio";

interface Requirement {
  path: string;
  tokens: string[];
}

const REQUIREMENTS: Requirement[] = [
  {
    path: "src/sessionio.ts",
    tokens: [
      `SESSIONIO_API_VERSION = ${EXPECTED_SESSIONIO_API_VERSION}`,
      "registerSessionTransport",
      "resolveSessionTransport",
    ],
  },
  {
    path: "src/index.ts",
    tokens: ["@nanoclaw-sessionio:index-boot:begin"],
  },
];

export function findSessionioIssues(nanoclawRoot: string): string[] {
  const issues: string[] = [];
  for (const requirement of REQUIREMENTS) {
    const filePath = path.join(nanoclawRoot, requirement.path);
    if (!fs.existsSync(filePath)) {
      issues.push(`missing sessionio file ${requirement.path}`);
      continue;
    }
    const source = fs.readFileSync(filePath, "utf8");
    for (const token of requirement.tokens) {
      if (!source.includes(token)) {
        issues.push(
          `${requirement.path} missing sessionio API v${EXPECTED_SESSIONIO_API_VERSION} capability ${token}`,
        );
      }
    }
  }
  return issues;
}

export function sessionioInstallGuidance(): string {
  return INSTALL_GUIDANCE;
}

/**
 * Install gate: require the sessionio module API.
 * Boot marker presence is enforced by `verify` (and install patches index afterward).
 */
export function requireSessionio(nanoclawRoot: string): void {
  const issues = findSessionioIssues(nanoclawRoot).filter(
    (issue) => !issue.includes("src/index.ts"),
  );
  if (issues.length === 0) return;
  throw new Error(
    `nanoclaw-sessionio API v${EXPECTED_SESSIONIO_API_VERSION} is required (${issues.join("; ")}). ${INSTALL_GUIDANCE}`,
  );
}
