---
task: cli-based-personal-task-management-application
type: plan
repo: qrspi-todo
branch: n/a (greenfield)
sha: n/a
---

# CLI Todo App Implementation Plan

## Overview

Build a minimal command-line todo application using Citty for CLI parsing and JSON with atomic writes for storage. The app supports four core operations: add, list, done, and delete tasks. This is a greenfield TypeScript project targeting users who work primarily in the terminal.

## Current State Analysis

- Empty repository ready for scaffolding
- No existing code or dependencies
- No git history yet

### Key Discoveries

- **CLI Framework**: Citty provides TypeScript-first design with `defineCommand()` for end-to-end type inference, zero dependencies
- **Storage**: JSON + write-file-atomic is sufficient for personal task volumes (< 10K tasks), human-readable for debugging
- **Data Location**: env-paths provides XDG-compliant cross-platform paths (`~/.local/share/todo/` on Linux, `~/Library/Application Support/todo/` on macOS)
- **Build**: esbuild with shebang banner injection is the fastest approach for CLI bundling

```ts
import { defineCommand } from "citty";

export const addCommand = defineCommand({
  meta: { name: "add", description: "Add a new todo" },
  args: { text: { type: "positional", required: true } },
  run({ args }) {
    return appendTask(args.text);
  },
});
```

## Desired End State

- Working `todo` CLI binary with `add`, `list`, `done`, `delete` subcommands
- Each command has single-letter aliases (`a`, `l`/`ls`, `d`, `rm`)
- Tasks stored in XDG-compliant JSON file
- Sequential integer IDs that never change once assigned
