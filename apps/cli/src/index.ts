#!/usr/bin/env bun
import { defineCommand, runMain } from "citty";
import { reviewCommand } from "./commands/review.js";
import { orgCommand } from "./commands/org.js";
import { userCommand } from "./commands/user.js";
import { projectCommand } from "./commands/project.js";

const KNOWN_SUBCOMMANDS = new Set(["review", "org", "user", "project"]);

/**
 * Bare-file fallback: `mark-it foo.md --port 5173` should still work.
 * If the first arg isn't a known subcommand, prepend "review" so citty
 * routes accordingly. Hard-coded set avoids surprising behaviour on typos.
 */
function preprocessArgv(argv: string[]): string[] {
  const first = argv[0];
  if (!first) return argv;
  if (first.startsWith("-")) return argv;
  if (KNOWN_SUBCOMMANDS.has(first)) return argv;
  return ["review", ...argv];
}

const main = defineCommand({
  meta: { name: "mark-it", description: "Markdown review with comments and agents." },
  subCommands: {
    review: reviewCommand,
    org: orgCommand,
    user: userCommand,
    project: projectCommand,
  },
});

process.argv.splice(2, process.argv.length - 2, ...preprocessArgv(process.argv.slice(2)));
runMain(main);
