import { pool } from "../db.js";

export async function getDashboard() {
  const [[cand]] = await pool.query("SELECT COUNT(*) AS total, SUM(allocated_ic IS NULL) AS unallocated FROM candidates");
  const [[req]] = await pool.query(
    "SELECT COUNT(*) AS rows_count, SUM(newvalue) AS capacity_total, SUM(allocated) AS allocated_total, SUM(newvalue - allocated) AS remaining_total FROM requirements"
  );
  const [topZones] = await pool.query(
    "SELECT allocated_zone AS zone, COUNT(*) AS count FROM candidates WHERE allocated_zone IS NOT NULL GROUP BY allocated_zone ORDER BY count DESC LIMIT 10"
  );
  return {
    candidates: cand,
    requirements: req,
    topZones
  };
}
