import type { PoolConnection } from "mysql2/promise";
import type { AllocationInput, Candidate } from "../types.js";

function normProfile(v: unknown): string {
  if (v == null) return "";
  return String(v).trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Distinct normalized profiles that appear on **any** `requirements` row (ignores remaining/newvalue),
 * optionally narrowed by the same gender/discipline filters as allocation.
 */
export async function loadRequirementProfilesCatalog(
  conn: PoolConnection,
  input: Pick<AllocationInput, "gender" | "profile" | "discipline">
): Promise<Set<string>> {
  const where: string[] = [`TRIM(COALESCE(profile,'')) <> ''`];
  const params: string[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(normProfile(input.gender));
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(normProfile(input.profile));
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(normProfile(input.discipline));
  }
  const [rows] = await conn.query(
    `SELECT DISTINCT TRIM(profile) AS profile FROM requirements WHERE ${where.join(" AND ")}`,
    params
  );
  return new Set(
    (rows as { profile: unknown }[]).map((r) => normProfile(r.profile)).filter(Boolean)
  );
}

export type ProfileWithoutRequirements = {
  /** Representative spelling from a candidate row. */
  profile: string;
  candidateCount: number;
  message: string;
};

/**
 * For each profile present on candidates in the pool, flags profiles that never appear on `requirements`
 * (for the same gender/discipline filter scope as the catalog query).
 */
export function computeProfilesMissingRequirements(
  candidates: Candidate[],
  requirementProfilesNormalized: Set<string>
): ProfileWithoutRequirements[] {
  const byNorm = new Map<string, { display: string; count: number }>();
  for (const c of candidates) {
    const raw = String(c.profile ?? "").trim();
    if (!raw) continue;
    const n = normProfile(c.profile);
    const cur = byNorm.get(n) ?? { display: raw, count: 0 };
    cur.count += 1;
    byNorm.set(n, cur);
  }

  const gaps: ProfileWithoutRequirements[] = [];
  for (const [n, { display, count }] of byNorm) {
    if (!requirementProfilesNormalized.has(n)) {
      gaps.push({
        profile: display,
        candidateCount: count,
        message: `No requirement rows exist for profile "${display}" (with current gender/discipline filters). These candidates cannot be allocated until matching requirements are added.`
      });
    }
  }
  gaps.sort((a, b) => a.profile.localeCompare(b.profile, undefined, { sensitivity: "base" }));
  return gaps;
}
