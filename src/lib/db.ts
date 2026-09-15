import pg from "pg";
import { env } from "../config";

let pool: pg.Pool | undefined;
function getPool() {
  pool ??= new pg.Pool({
    connectionString: env("DATABASE_URL"),
    ssl: process.env.PGSSL === "disable" ? false : { rejectUnauthorized: true },
    max: 3,
    keepAlive: true,                 // serverless Postgres drops idle sockets
    idleTimeoutMillis: 10_000,       // recycle before the server does it for us
    connectionTimeoutMillis: 15_000,
  });
  pool.on("error", (e) => console.warn(`postgres pool error (will reconnect): ${e.message}`));
  return pool;
}

/** Retries the "Connection terminated unexpectedly" class of error, which is routine on serverless Postgres. */
export async function q<T = any>(sql: string, params: unknown[] = []): Promise<T[]> {
  let last: unknown;
  for (let i = 0; i < 3; i++) {
    try {
      return (await getPool().query(sql, params)).rows as T[];
    } catch (e) {
      last = e;
      const msg = (e as Error).message ?? "";
      if (!/terminated unexpectedly|Connection terminated|ECONNRESET|server closed|timeout exceeded/i.test(msg)) throw e;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw last;
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
