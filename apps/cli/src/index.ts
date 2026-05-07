#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { reviewCommand } from "./commands/review.js";
import { orgCommand } from "./commands/org.js";
import { userCommand } from "./commands/user.js";
import { projectCommand } from "./commands/project.js";
import { daemonCommand } from "./commands/daemon.js";
import { openCommand } from "./commands/open.js";

const KNOWN_SUBCOMMANDS = new Set([
  "review",
  "org",
  "user",
  "project",
  "daemon",
  "open",
]);

/**
 * Bare-file fallback: `mark-it foo.md` opens via the daemon (thin client).
 * If the first arg isn't a known subcommand, prepend "open" so citty
 * routes accordingly.
 */
function preprocessArgv(argv: string[]): string[] {
  const first = argv[0];
  if (!first) return argv;
  if (first.startsWith("-")) return argv;
  if (KNOWN_SUBCOMMANDS.has(first)) return argv;
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
  },
});

process.argv.splice(2, process.argv.length - 2, ...preprocessArgv(process.argv.slice(2)));
runMain(main);
