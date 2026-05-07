import { defineCommand } from "citty";
import { openDbForCommand, requireOrg } from "./util.js";
import { listProjects } from "../db/queries.js";

export const projectCommand = defineCommand({
  meta: { name: "project" },
  subCommands: {
    list: defineCommand({
      meta: { name: "list" },
      args: {
        org: { type: "string", required: true },
        db: { type: "string", required: false },
      },
      run({ args }) {
        const { db } = openDbForCommand({ db: args.db as string | undefined });
        const org = requireOrg(db, args.org as string);
        for (const p of listProjects(db, org.id)) console.log(`${p.name}\t${p.id}`);
      },
    }),
  },
});
