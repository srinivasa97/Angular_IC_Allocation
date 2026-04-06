import type { RowDataPacket } from "mysql2";
import { pool } from "../db.js";

function mergeRows(a: RowDataPacket[], b: RowDataPacket[]): string[] {
  const set = new Set<string>();
  for (const r of [...a, ...b]) {
    const s = String((r as { v: unknown }).v ?? "").trim();
    if (s) set.add(s);
  }
  return [...set].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

export type FilterOptionsQuery = {
  /** When set, disciplines are limited to rows with this profile (candidates ∪ requirements). */
  profile?: string;
  /** When set with profile, disciplines also filtered by gender; if only gender set, filter by gender only. */
  gender?: string;
  /** Narrows `requirementSlice` counts only (not the discipline dropdown list). */
  discipline?: string;
};

export type RequirementSliceStats = {
  /** Rows with `newvalue > 0` after filters — same slice as fresh simulate loads from `requirements`. */
  requirementRowCount: number;
  /** Sum of `newvalue` on those rows (total seat capacity for the slice). */
  totalSeatsNewvalue: number;
};

function buildDisciplineFilters(table: "candidates" | "requirements", q: FilterOptionsQuery): { sql: string; params: string[] } {
  const parts = [`TRIM(COALESCE(discipline,'')) <> ''`];
  const params: string[] = [];
  const profile = q.profile?.trim();
  const gender = q.gender?.trim();
  if (profile) {
    parts.push(`LOWER(TRIM(${table}.profile)) = LOWER(?)`);
    params.push(profile);
  }
  if (gender) {
    parts.push(`LOWER(TRIM(${table}.gender)) = LOWER(?)`);
    params.push(gender);
  }
  return {
    sql: `SELECT DISTINCT TRIM(discipline) AS v FROM ${table} WHERE ${parts.join(" AND ")}`,
    params
  };
}

/** Same `requirements` slice as `loadRequirements` with `simulateFromFresh` (capacity from `newvalue > 0`). */
async function getRequirementSliceStats(q: FilterOptionsQuery): Promise<RequirementSliceStats> {
  const where: string[] = ["newvalue > 0"];
  const params: string[] = [];
  const profile = q.profile?.trim();
  const gender = q.gender?.trim();
  const discipline = q.discipline?.trim();
  if (profile) {
    where.push("LOWER(TRIM(profile)) = LOWER(?)");
    params.push(profile);
  }
  if (gender) {
    where.push("LOWER(TRIM(gender)) = LOWER(?)");
    params.push(gender);
  }
  if (discipline) {
    where.push("LOWER(TRIM(discipline)) = LOWER(?)");
    params.push(discipline);
  }
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT COUNT(*) AS rowCount, COALESCE(SUM(newvalue), 0) AS totalSeatsNewvalue FROM requirements WHERE ${where.join(" AND ")}`,
    params
  );
  const r = rows[0] as { rowCount: number; totalSeatsNewvalue: number | string } | undefined;
  return {
    requirementRowCount: Number(r?.rowCount ?? 0),
    totalSeatsNewvalue: Number(r?.totalSeatsNewvalue ?? 0)
  };
}

/**
 * Distinct gender / profile / discipline from candidates ∪ requirements for UI dropdowns.
 * Optional `profile` / `gender` narrow the **disciplines** list only (for cascading dropdowns).
 * Optional `discipline` (with or without the others) narrows **requirementSlice** counts to match a simulate/run filter set.
 */
export async function getAllocationFilterOptions(q: FilterOptionsQuery = {}) {
  const [gCand] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT TRIM(gender) AS v FROM candidates WHERE TRIM(COALESCE(gender,'')) <> ''`
  );
  const [gReq] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT TRIM(gender) AS v FROM requirements WHERE TRIM(COALESCE(gender,'')) <> ''`
  );
  const [pCand] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT TRIM(profile) AS v FROM candidates WHERE TRIM(COALESCE(profile,'')) <> ''`
  );
  const [pReq] = await pool.query<RowDataPacket[]>(
    `SELECT DISTINCT TRIM(profile) AS v FROM requirements WHERE TRIM(COALESCE(profile,'')) <> ''`
  );

  const dCandQ = buildDisciplineFilters("candidates", q);
  const dReqQ = buildDisciplineFilters("requirements", q);
  const [dCand] = await pool.query<RowDataPacket[]>(dCandQ.sql, dCandQ.params);
  const [dReq] = await pool.query<RowDataPacket[]>(dReqQ.sql, dReqQ.params);

  const requirementSlice = await getRequirementSliceStats(q);

  return {
    genders: mergeRows(gCand, gReq),
    profiles: mergeRows(pCand, pReq),
    disciplines: mergeRows(dCand, dReq),
    requirementSlice
  };
}
