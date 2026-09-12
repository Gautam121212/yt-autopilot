import pg from "pg";
import { env } from "../config";

let pool: pg.Pool | undefined;
function getPool() {
  pool ??= new pg.Pool({
    connectionString: env("DATABASE_URL"),
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
    max: 3,
  });
  return pool;
}

export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await getPool().query(sql, params)).rows as T[];
}

export async function updateVideo(id: number, fields: Record<string, unknown>) {
  const keys = Object.keys(fields);
  const sets = keys.map((k, i) => `${k} = $${i + 2}`).join(", ");
  const vals = keys.map((k) => {
    const v = fields[k];
    return v !== null && typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v;
  });
  await q(`update videos set ${sets}, updated_at = now() where id = $1`, [id, ...vals]);
}

export async function closeDb() {
  await pool?.end();
}
