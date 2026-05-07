import { defineCommand } from "citty";
import { openDbForCommand } from "./util.js";
import { createOrg, listOrgs, findOrgByName } from "../db/queries.js";

export const orgCommand = defineCommand({
  meta: { name: "org", description: "Manage organisations." },
  subCommands: {
    create: defineCommand({
      meta: { name: "create" },
      args: {
        name: { type: "positional", required: true },
        db: { type: "string", required: false },
      },
      run({ args }) {
        const db_path = args.db as string | undefined;
        const { db } = openDbForCommand({ db: db_path });
        const name = args.name as string;
        if (findOrgByName(db, name)) {
          console.error(`mark-it: org "${name}" already exists`);
          process.exit(1);
        }
        const row = createOrg(db, name);
        console.log(`Created org ${row.name} (${row.id})`);
      },
    }),
    list: defineCommand({
      meta: { name: "list" },
      args: { db: { type: "string", required: false } },
      run({ args }) {
        const { db } = openDbForCommand({ db: args.db as string | undefined });
        for (const o of listOrgs(db)) console.log(`${o.name}\t${o.id}`);
      },
    }),
  },
});
