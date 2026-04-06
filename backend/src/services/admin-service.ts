import { pool, withTransaction } from "../db.js";

const allowed = new Set(["seq_gender", "seq_profile_discipline", "seq_zone", "seq_business"]);

function assertTable(table: string): void {
  if (!allowed.has(table)) throw new Error("Invalid sequence table");
}

export async function getSequenceTable(table: string) {
  assertTable(table);
  const [rows] = await pool.query(`SELECT * FROM ${table} ORDER BY id ASC`);
  return rows;
}

export async function updateSequenceRow(table: string, id: number, patch: Record<string, unknown>) {
  assertTable(table);
  const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
  if (!entries.length) return { ok: true, skipped: true };
  const sets = entries.map(([key]) => `${key} = ?`).join(", ");
  const values = entries.map(([, value]) => value);
  await pool.query(`UPDATE ${table} SET ${sets} WHERE id = ?`, [...values, id]);
  return { ok: true };
}

export async function prepareRequirements() {
  return withTransaction(async (conn) => {
    await conn.query(
      `
      UPDATE requirements
      SET increase = FLOOR(COALESCE(actualvalue, 0) * COALESCE(percentagetoincrease, 0))
      `
    );

    await conn.query("CALL process_data()");

    await conn.query(
      `
      UPDATE requirements
      SET newvalue = COALESCE(actualvalue, 0) + COALESCE(increase, 0) + COALESCE(adjustment, 0),
          allocated = COALESCE(allocated, 0)
      `
    );

    const [[summary]] = await conn.query(
      `
      SELECT
        COUNT(*) AS rows_count,
        COALESCE(SUM(actualvalue), 0) AS actual_total,
        COALESCE(SUM(newvalue), 0) AS capacity_total,
        COALESCE(SUM(allocated), 0) AS allocated_total,
        COALESCE(SUM(newvalue - allocated), 0) AS remaining_total
      FROM requirements
      `
    );

    return {
      ok: true,
      message: "Requirements pre-processing completed",
      summary
    };
  });
}
