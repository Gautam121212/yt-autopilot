import fs from "node:fs";
import path from "node:path";
import { ROOT } from "../config";
import { closeDb, q } from "../lib/db";

await q(fs.readFileSync(path.join(ROOT, "db/schema.sql"), "utf8"));
console.log("schema applied");
await closeDb();
