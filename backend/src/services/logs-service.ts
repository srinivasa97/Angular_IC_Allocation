import { pool } from "../db.js";

export async function getAllocationLogs(limit = 200) {
  const [business] = await pool.query(
    "SELECT * FROM logs_business ORDER BY id DESC LIMIT ?",
    [Math.min(Math.max(Number(limit) || 200, 1), 2000)]
  );
  const [zone] = await pool.query(
    "SELECT * FROM logs_zone ORDER BY id DESC LIMIT ?",
    [Math.min(Math.max(Number(limit) || 200, 1), 2000)]
  );
  return { business, zone };
}
