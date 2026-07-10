#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { reviewCommand } from "./commands/review.js";
import { orgCommand } from "./commands/org.js";
import { userCommand } from "./commands/user.js";
import { projectCommand } from "./commands/project.js";
import { daemonCommand } from "./commands/daemon.js";
import { openCommand } from "./commands/open.js";
import { tailCommand } from "./commands/tail.js";

const KNOWN_SUBCOMMANDS = new Set([
  "review",
  "org",
  "user",
  "project",
  "daemon",
  "open",
  "tail",
]);

/**
 * Bare-file fallback: `mark-it foo.md` opens via the daemon (thin client).
 * If no known subcommand appears before the first non-flag arg, prepend
 * "open" so citty routes accordingly — including leading flags like
 * `mark-it --no-open foo.md`.
 */
function preprocessArgv(argv: string[]): string[] {
  if (argv.length === 0) return argv;
  for (const arg of argv) {
    if (arg.startsWith("-")) continue;
    if (KNOWN_SUBCOMMANDS.has(arg)) return argv;
    // First positional is a file path (or similar) → default to open.
    return ["open", ...argv];
  }
  // Flags only (e.g. `mark-it --no-open` with stdin) → still open.
  return ["open", ...argv];
}

const main = defineCommand({
  meta: { name: "mark-it", description: "Markdown review with comments and agents." },
  subCommands: {
    review: reviewCommand,
    org: orgCommand,
    user: userCommand,
    project: projectCommand,
    daemon: daemonCommand,
    open: openCommand,
    tail: tailCommand,
  },
});

process.argv.splice(2, process.argv.length - 2, ...preprocessArgv(process.argv.slice(2)));
runMain(main);
