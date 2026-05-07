import { defineCommand } from "citty";
import { openDbForCommand, requireOrg, normaliseHandle } from "./util.js";
import { createUser, findUserByHandle, listUsers } from "../db/queries.js";

export const userCommand = defineCommand({
  meta: { name: "user" },
  subCommands: {
    add: defineCommand({
      meta: { name: "add" },
      args: {
        handle: { type: "positional", required: true },
        org: { type: "string", required: true },
        email: { type: "string", required: false },
        db: { type: "string", required: false },
      },
      run({ args }) {
        const { db } = openDbForCommand({ db: args.db as string | undefined });
        const org = requireOrg(db, args.org as string);
        const handle = normaliseHandle(args.handle as string);
        if (findUserByHandle(db, org.id, handle)) {
          console.error(`mark-it: user ${handle} already in org ${org.name}`);
          process.exit(1);
        }
        const u = createUser(db, org.id, handle, (args.email as string | undefined) ?? null);
        console.log(`Added user ${u.handle} to org ${org.name} (${u.id})`);
      },
    }),
    list: defineCommand({
      meta: { name: "list" },
      args: {
        org: { type: "string", required: true },
        db: { type: "string", required: false },
      },
      run({ args }) {
        const { db } = openDbForCommand({ db: args.db as string | undefined });
        const org = requireOrg(db, args.org as string);
        for (const u of listUsers(db, org.id)) {
          console.log(`${u.handle}\t${u.email ?? ""}\t${u.id}`);
        }
      },
    }),
  },
});
