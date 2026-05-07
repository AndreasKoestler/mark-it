import { defineCommand } from "citty";
import { startDaemon } from "../daemon/index.js";
import { openDbForCommand } from "./util.js";

export const daemonCommand = defineCommand({
  meta: {
    name: "daemon",
    description: "Run the mark-it daemon — long-lived host for many docs.",
  },
  args: {
    port: {
      type: "string",
      description: "Port to bind to (0 = pick at random).",
      default: "0",
    },
    host: {
      type: "string",
      description: "Host to bind to.",
      default: "127.0.0.1",
    },
    "idle-secs": {
      type: "string",
      description: "Idle exit threshold in seconds. 0 = never auto-exit.",
      default: String(
        Number(process.env.MARK_IT_DAEMON_IDLE_SECS) || 600,
      ),
    },
    db: {
      type: "string",
      description: "Optional DB path (multi-user mode).",
      required: false,
    },
  },
  async run({ args }) {
    const port = Number(args.port) || 0;
    const idleSecs = Number(args["idle-secs"]) || 0;
    const host = args.host || "127.0.0.1";
    const db = args.db ? openDbForCommand({ db: args.db }).db : undefined;
    await startDaemon({ port, host, idleSecs, db });
  },
});
