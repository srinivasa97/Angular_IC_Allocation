import type { PoolConnection } from "mysql2/promise";
import { z } from "zod";
import { withTransaction } from "../db.js";
import type { AllocationInput, AllocationMode, Candidate, RequirementRow } from "../types.js";
import { pickRowString } from "../util/row-fields.js";
import { executeLegacyTwoPhaseScript } from "./legacy-two-phase-engine.js";
import {
  computeProfilesMissingRequirements,
  loadRequirementProfilesCatalog,
  type ProfileWithoutRequirements
} from "./profile-coverage.js";

const requestSchema = z.object({
  gender: z.string().optional(),
  profile: z.string().optional(),
  discipline: z.string().optional(),
  resetBeforeRun: z.boolean().optional(),
  /** When true, response includes `processingTrace` with ordered steps for auditing. */
  includeTrace: z.boolean().optional(),
  maxPerIc: z.preprocess(
    (v) => (v === "" || v === null || v === undefined ? undefined : v),
    z.number().int().positive().optional()
  ),
  preferSuggestedIc: z.boolean().optional(),
  ignoreRoleSuitability: z.boolean().optional(),
  /** When true, seat-line gender vs candidate gender is not enforced for matching or picks. */
  ignoreGender: z.boolean().optional(),
  /** Second pass: fill remaining seats from unassigned pool only, ignoring HR role vs seat line. */
  hrRelaxUnassignedSecondPass: z.boolean().optional(),
  /** Third pass: still-unassigned only; relax seat-line gender vs candidate; HR same as primary. */
  genderRelaxUnassignedThirdPass: z.boolean().optional(),
  includeUnassignedLog: z.boolean().optional(),
  phasedPreference: z.boolean().optional(),
  /** Old Node script: zones then business, `requirements_zone_calculated` + seq tables. */
  useLegacyTwoPhaseScript: z.boolean().optional(),
  filters: z
    .object({
      gender: z.string().optional(),
      profile: z.string().optional(),
      discipline: z.string().optional(),
      resetBeforeRun: z.boolean().optional(),
      includeTrace: z.boolean().optional(),
      maxPerIc: z.preprocess(
        (v) => (v === "" || v === null || v === undefined ? undefined : v),
        z.number().int().positive().optional()
      ),
      preferSuggestedIc: z.boolean().optional(),
      ignoreRoleSuitability: z.boolean().optional(),
      ignoreGender: z.boolean().optional(),
      hrRelaxUnassignedSecondPass: z.boolean().optional(),
      genderRelaxUnassignedThirdPass: z.boolean().optional(),
      includeUnassignedLog: z.boolean().optional(),
      phasedPreference: z.boolean().optional(),
      useLegacyTwoPhaseScript: z.boolean().optional()
    })
    .optional()
});

type PreferencePhase = "P1" | "P2" | "P3" | "NP";

/** Eligibility for requirement rows (picks, diagnostics, unassigned insights). */
type EligibilityOptions = { ignoreRoleSuitability: boolean; ignoreGender: boolean };

const PREFERENCE_PHASES: PreferencePhase[] = ["P1", "P2", "P3", "NP"];
const ZONE_ROUND_ORDER = ["north", "south", "east", "west"] as const;

type Assignment = {
  requirementId: number;
  candidateId: number;
  email: string;
  meritscore: number;
  /** Candidate attributes at time of assignment (for reporting). */
  profile: string;
  discipline: string;
  gender: string;
  zone: string;
  business: string;
  icname: string;
  /** True only when preferSuggestedIc was on and chosen candidate's suggested_ic matched requirement.icname. Always false when preferSuggestedIc is off. */
  suggestedIcMatch: boolean;
  /** Raw HR suggested IC on candidate (empty string if none). */
  suggestedIc: string;
  /** Candidate business1 / business2 / business3 (joined), often used as service-line preferences. */
  servicePreferences: string;
  /** HR role line on requirement (if any). */
  requirementRoleName: string | null;
  /** Candidate HR suitability value (if any). */
  candidateSuitable: string | null;
  /** How role_name was applied for this pick. */
  roleSuitability: "not_required" | "matched" | "hr_blank_allowed" | "ineligible_blank_hr";
  /** P1=zone1 only, P2=zone2, P3=zone3, NP=anywhere/flexible (legacy OR). Legacy mode uses "ANY". */
  preferencePhase: PreferencePhase | "ANY";
  zone1?: string;
  zone2?: string;
  zone3?: string;
  business1?: string;
  business2?: string;
  business3?: string;
  eligibilityVerdict?: "MATCHED";
  zoneMatchBasis?: string;
  businessMatchBasis?: string;
  eligiblePoolSize?: number;
  eligibleRank?: number;
  topEligibleCandidateId?: number | null;
  topEligibleCandidateEmail?: string | null;
  requirementRemainingBefore?: number;
  requirementRemainingAfter?: number;
  permanentZone?: string;
  permanentState?: string;
  sameAsP1?: boolean;
  /** Set when the row was created in the optional HR-relaxed second pass (still-unassigned candidates only). */
  hrRelaxedSecondPass?: boolean;
  /** Seat line gender (`requirements.gender`) at pick time. */
  requirementGender?: string;
  /** Optional third pass: still-unassigned only; gender not enforced vs seat line; HR same as primary. */
  genderRelaxedThirdPass?: boolean;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function normalize(value: unknown): string {
  return asText(value).trim().toLowerCase().replace(/\s+/g, " ");
}

/** Map common zone labels to a single key so requirement.zone and candidate.zone* align. */
function canonicalCardinalZone(value: unknown): string | null {
  const n = normalize(value);
  if (!n) return null;
  const compact = n.replace(/[^a-z0-9]/g, "");
  const aliases: Record<string, string> = {
    n: "north",
    north: "north",
    s: "south",
    south: "south",
    e: "east",
    east: "east",
    w: "west",
    west: "west"
  };
  if (aliases[n]) return aliases[n];
  if (aliases[compact]) return aliases[compact];
  const firstToken = n.split(/\s+/)[0] ?? "";
  if (aliases[firstToken]) return aliases[firstToken];
  return null;
}

function candidateZoneKeys(candidate: Candidate): string[] {
  const keys = [
    canonicalCardinalZone(candidate.zone1),
    canonicalCardinalZone(candidate.zone2),
    canonicalCardinalZone(candidate.zone3)
  ].filter((k): k is string => Boolean(k));
  return [...new Set(keys)];
}

function candidateZones(candidate: Candidate): string[] {
  return [normalize(candidate.zone1), normalize(candidate.zone2), normalize(candidate.zone3)].filter(Boolean);
}

function candidateBusinesses(candidate: Candidate): string[] {
  return [normalize(candidate.business1), normalize(candidate.business2), normalize(candidate.business3)].filter(Boolean);
}

/** Legacy / NP: true if any of zone1/2/3 matches requirement zone (canonical or exact). */
function zoneMatchesAnyPreference(candidate: Candidate, reqZone: string): boolean {
  const bz = normalize(reqZone);
  if (!bz) return true;
  const reqKey = canonicalCardinalZone(reqZone);
  const candKeys = candidateZoneKeys(candidate);
  if (reqKey && candKeys.some((k) => k === reqKey)) return true;
  return candidateZones(candidate).includes(bz);
}

/** NP / “no preference”: empty prefs, or explicit anywhere / np text in any slot. */
function isNpStyleCandidate(candidate: Candidate): boolean {
  const z1 = normalize(candidate.zone1);
  const z2 = normalize(candidate.zone2);
  const z3 = normalize(candidate.zone3);
  const slots = [z1, z2, z3].filter(Boolean);
  if (slots.length === 0) return true;
  const npTokens = ["anywhere", "any", "np", "no preference", "nopreference", "none", "nil", "flex", "not specific"];
  return slots.some((z) => npTokens.some((t) => z.includes(t)));
}

/**
 * EduTech flow: P1 uses only zone1 vs requirement zone; P2 only zone2; P3 only zone3;
 * NP uses flexible / anywhere OR legacy any-match.
 */
function zoneMatchesPreferencePhase(candidate: Candidate, reqZone: string, phase: PreferencePhase): boolean {
  const key = canonicalCardinalZone(reqZone);
  if (!key) return true;
  if (phase === "NP") {
    if (isNpStyleCandidate(candidate)) return true;
    return zoneMatchesAnyPreference(candidate, reqZone);
  }
  const zField = phase === "P1" ? candidate.zone1 : phase === "P2" ? candidate.zone2 : candidate.zone3;
  const ck = canonicalCardinalZone(zField);
  if (ck && ck === key) return true;
  return normalize(zField) === normalize(reqZone);
}

function baseRequirementMatch(candidate: Candidate, req: RequirementRow, opts: EligibilityOptions): boolean {
  if (normalize(candidate.profile) !== normalize(req.profile)) return false;
  if (normalize(candidate.discipline) !== normalize(req.discipline)) return false;
  if (!opts.ignoreGender && normalize(candidate.gender) !== normalize(req.gender)) return false;
  if (!legacyAllocatedRoleMatches(candidate, req)) return false;
  return hrRoleSuitabilityMatches(candidate, req, opts.ignoreRoleSuitability);
}

function requirementEligibleForPhase(
  candidate: Candidate,
  req: RequirementRow,
  options: EligibilityOptions,
  phase: PreferencePhase
): boolean {
  if (!baseRequirementMatch(candidate, req, options)) return false;
  if (!businessMatchesCandidate(candidate, req.business)) return false;
  return zoneMatchesPreferencePhase(candidate, req.zone, phase);
}

function candidatePotentiallyEligiblePhased(
  candidate: Candidate,
  requirements: RequirementRow[],
  options: EligibilityOptions
): boolean {
  for (const req of requirements) {
    for (const phase of PREFERENCE_PHASES) {
      if (requirementEligibleForPhase(candidate, req, options, phase)) return true;
    }
  }
  return false;
}

function businessMatchesCandidate(candidate: Candidate, reqBusiness: string): boolean {
  const bb = normalize(reqBusiness);
  if (!bb) return true;
  return candidateBusinesses(candidate).includes(bb);
}

/** Legacy: pre-set allocated_role must match requirement profile when present. */
function legacyAllocatedRoleMatches(candidate: Candidate, requirement: RequirementRow): boolean {
  const cRole = normalize(candidate.allocated_role);
  if (!cRole) return true;
  return cRole === normalize(requirement.profile);
}

/**
 * HR: requirements.role_name vs candidates.candidate_suitable.
 * When ignoreRoleSuitability is false (Panel HR strict): candidate_suitable must be non-empty after trim, or the
 * candidate cannot match any seat. When role_name is set on the seat, candidate_suitable must match it (normalized).
 * When ignoreRoleSuitability is true, HR suitability is not enforced.
 */
function hrRoleSuitabilityMatches(candidate: Candidate, req: RequirementRow, ignoreRoleSuitability: boolean): boolean {
  if (ignoreRoleSuitability) return true;
  const suit = normalize(candidate.candidate_suitable ?? "");
  if (!suit) return false;
  const rn = normalize(req.role_name ?? "");
  if (!rn) return true;
  return suit === rn;
}

function classifyRoleSuitability(
  candidate: Candidate,
  req: RequirementRow,
  ignoreRoleSuitability: boolean
): "not_required" | "matched" | "hr_blank_allowed" | "ineligible_blank_hr" {
  if (ignoreRoleSuitability) return "not_required";
  const suit = normalize(candidate.candidate_suitable ?? "");
  if (!suit) return "ineligible_blank_hr";
  const rn = normalize(req.role_name ?? "");
  if (!rn) return "not_required";
  return "matched";
}

function suggestedIcMatchesRequirement(candidate: Candidate, req: RequirementRow): boolean {
  const s = normalize(candidate.suggested_ic ?? "");
  if (!s) return false;
  return s === normalize(req.icname);
}

/** Candidate-stated business lines (often “services”), for reporting. */
function candidateServicePreferences(candidate: Candidate): string {
  const parts = [candidate.business1, candidate.business2, candidate.business3]
    .map((v) => asText(v).trim())
    .filter(Boolean);
  return parts.join(" · ");
}

function zoneMatchBasisForPhase(candidate: Candidate, req: RequirementRow, phase: PreferencePhase | "ANY"): string {
  const reqNorm = normalize(req.zone);
  if (phase === "P1") return normalize(candidate.zone1) === reqNorm ? "zone1" : "zone1(normalized)";
  if (phase === "P2") return normalize(candidate.zone2) === reqNorm ? "zone2" : "zone2(normalized)";
  if (phase === "P3") return normalize(candidate.zone3) === reqNorm ? "zone3" : "zone3(normalized)";
  if (normalize(candidate.zone1) === reqNorm) return "zone1";
  if (normalize(candidate.zone2) === reqNorm) return "zone2";
  if (normalize(candidate.zone3) === reqNorm) return "zone3";
  if (isNpStyleCandidate(candidate)) return "anywhere/flexible";
  return "any-zone";
}

function businessMatchBasis(candidate: Candidate, req: RequirementRow): string {
  const rb = normalize(req.business);
  if (normalize(candidate.business1) === rb) return "business1";
  if (normalize(candidate.business2) === rb) return "business2";
  if (normalize(candidate.business3) === rb) return "business3";
  return "business(any)";
}

function normalizeZoneLikeForComparison(value: unknown): string {
  const n = normalize(value);
  if (!n) return "";
  const ck = canonicalCardinalZone(n);
  if (ck) return ck;
  return n
    .replace(/\bregion\b/g, "")
    .replace(/\bzone\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function sameAsP1(candidate: Candidate): boolean | null {
  const z1 = normalizeZoneLikeForComparison(candidate.zone1);
  // Primary rule: compare P1 (zone1) with Permanent Zone; fallback to Permanent State if zone missing.
  const pz = normalizeZoneLikeForComparison(candidate.permanent_zone ?? candidate.permanent_state ?? "");
  if (!z1 || !pz) return null;
  return z1 === pz;
}

function zigZagIndex(i: number, n: number): number {
  if (n <= 1) return 0;
  const span = n - 1;
  const cycle = Math.floor(i / span);
  const offset = i % span;
  return cycle % 2 === 0 ? offset : span - offset;
}

/** First non-empty string from preferred columns, else first scalar column (except id). */
function extractSeqLabel(row: Record<string, unknown>, preferredKeys: string[]): string {
  for (const k of preferredKeys) {
    if (!(k in row)) continue;
    const s = asText(row[k]).trim();
    if (s) return s;
  }
  for (const [k, v] of Object.entries(row)) {
    if (k.toLowerCase() === "id" || v == null) continue;
    const s = asText(v).trim();
    if (s) return s;
  }
  return "";
}

/** Cardinal zone keys in table row order (id ASC). Null if table missing/empty/invalid. */
async function loadSeqZoneOrder(conn: PoolConnection): Promise<string[] | null> {
  try {
    const [rows] = await conn.query("SELECT * FROM seq_zone ORDER BY id ASC");
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of rows as Record<string, unknown>[]) {
      const label = extractSeqLabel(raw, ["zone", "zone_name", "name", "label"]);
      const ck = canonicalCardinalZone(label);
      if (ck && !seen.has(ck)) {
        seen.add(ck);
        out.push(ck);
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/** Normalized business names in table row order (id ASC). Null if table missing/empty. */
async function loadSeqBusinessOrder(conn: PoolConnection): Promise<string[] | null> {
  try {
    const [rows] = await conn.query("SELECT * FROM seq_business ORDER BY id ASC");
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of rows as Record<string, unknown>[]) {
      const label = extractSeqLabel(raw, ["business", "business_name", "name", "label"]);
      const n = normalize(label);
      if (n && !seen.has(n)) {
        seen.add(n);
        out.push(n);
      }
    }
    return out.length ? out : null;
  } catch {
    return null;
  }
}

/**
 * Zone iteration order: seq_zone first (when present), then default N,S,E,W, then any other
 * cardinal zones that appear on requirements.
 */
function buildEffectiveZoneOrder(seqZone: string[] | null, requirements: RequirementRow[]): string[] {
  const out: string[] = [];
  const add = (k: string) => {
    if (!out.includes(k)) out.push(k);
  };
  if (seqZone?.length) {
    for (const k of seqZone) add(k);
  }
  for (const k of ZONE_ROUND_ORDER) add(k);
  for (const r of requirements) {
    const k = canonicalCardinalZone(r.zone);
    if (k) add(k);
  }
  return out;
}

function compareRequirementRows(a: RequirementRow, b: RequirementRow): number {
  const d =
    normalize(a.discipline).localeCompare(normalize(b.discipline)) ||
    normalize(a.profile).localeCompare(normalize(b.profile)) ||
    normalize(a.gender).localeCompare(normalize(b.gender)) ||
    normalize(a.icname).localeCompare(normalize(b.icname));
  if (d !== 0) return d;
  return a.id - b.id;
}

/** Sort requirement rows for a fixed zone batch by seq_business, then tie-break. */
function sortRequirementsBySeqBusiness(
  rows: RequirementRow[],
  businessOrder: string[] | null
): RequirementRow[] {
  if (!businessOrder?.length) {
    return [...rows].sort(compareRequirementRows);
  }
  const rank = (business: string) => {
    const i = businessOrder.indexOf(normalize(business));
    return i === -1 ? 1_000_000 : i;
  };
  return [...rows].sort((a, b) => {
    const d = rank(a.business) - rank(b.business);
    if (d !== 0) return d;
    return compareRequirementRows(a, b);
  });
}

/** Legacy: order all requirement rows by effective zone order, then seq_business, then tie-break. */
function sortRequirementsForLegacyPass(
  requirements: RequirementRow[],
  effectiveZoneOrder: string[],
  businessOrder: string[] | null
): RequirementRow[] {
  const zRank = (r: RequirementRow) => {
    const k = canonicalCardinalZone(r.zone);
    if (!k) return 9999;
    const i = effectiveZoneOrder.indexOf(k);
    return i === -1 ? 8000 : i;
  };
  const bRank = (r: RequirementRow) => {
    if (!businessOrder?.length) return 0;
    const i = businessOrder.indexOf(normalize(r.business));
    return i === -1 ? 1_000_000 : i;
  };
  return [...requirements].sort((a, b) => {
    const z = zRank(a) - zRank(b);
    if (z !== 0) return z;
    const br = bRank(a) - bRank(b);
    if (br !== 0) return br;
    return compareRequirementRows(a, b);
  });
}

async function loadRequirements(
  conn: PoolConnection,
  input: AllocationInput,
  options?: { simulateFromFresh?: boolean }
): Promise<RequirementRow[]> {
  const simulateFromFresh = Boolean(options?.simulateFromFresh);
  const effectiveRemainingExpr = simulateFromFresh ? "newvalue" : "remaining";
  const where: string[] = [`${effectiveRemainingExpr} > 0`];
  const params: string[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(normalize(input.gender));
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(normalize(input.profile));
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(normalize(input.discipline));
  }
  const [rows] = await conn.query(
    `
      SELECT id, discipline, profile, gender, zone, business, icname, role_name, allocated, ${effectiveRemainingExpr} AS remaining
      FROM requirements
      WHERE ${where.join(" AND ")}
      ORDER BY discipline, profile, gender, zone, business, icname
    `,
    params
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    discipline: asText(r.discipline),
    profile: asText(r.profile),
    gender: asText(r.gender),
    zone: asText(r.zone),
    business: asText(r.business),
    icname: pickRowString(r, ["icname", "ic_name", "ICName", "ic"]),
    allocated: Number(r.allocated ?? 0),
    remaining: Number(r.remaining ?? 0),
    role_name: r.role_name != null ? asText(r.role_name) : null
  }));
}

async function loadCandidates(
  conn: PoolConnection,
  input: AllocationInput,
  options?: { simulateFromFresh?: boolean }
): Promise<Candidate[]> {
  const where: string[] = [];
  if (!options?.simulateFromFresh) {
    where.push("allocated_ic IS NULL", "allocated_business IS NULL");
  }
  const params: string[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(normalize(input.gender));
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(normalize(input.profile));
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(normalize(input.discipline));
  }
  const [colRows] = await conn.query(
    `
      SELECT LOWER(column_name) AS c
      FROM information_schema.columns
      WHERE table_schema = DATABASE()
        AND table_name = 'candidates'
        AND LOWER(column_name) IN ('permanent_state', 'domicile_state')
    `
  );
  const cols = new Set((colRows as Array<{ c?: string }>).map((r) => String(r.c ?? "").toLowerCase()));
  const permanentZoneExpr = "zone1 AS permanent_zone";
  const permanentStateExpr = cols.has("domicile_state")
    ? "domicile_state AS permanent_state"
    : cols.has("permanent_state")
      ? "permanent_state"
      : "NULL AS permanent_state";

  const [rows] = await conn.query(
    `
      SELECT id, email, discipline, profile, gender,
             zone1, zone2, zone3, business1, business2, business3,
             meritscore, allocated_zone, allocated_business, allocated_ic,
             NULL AS allocated_role,
             suggested_ic, candidate_suitable,
             ${permanentZoneExpr},
             ${permanentStateExpr}
      FROM candidates
      WHERE ${where.length ? where.join(" AND ") : "1=1"} and isManual = 0
      ORDER BY meritscore DESC, id ASC
    `,
    params
  );
  return rows as Candidate[];
}

async function getRequirementDiagnostics(
  conn: PoolConnection,
  input: AllocationInput,
  options?: { simulateFromFresh?: boolean }
) {
  const simulateFromFresh = Boolean(options?.simulateFromFresh);
  const effectiveRemainingExpr = simulateFromFresh ? "newvalue" : "remaining";
  const g = input.gender ? normalize(input.gender) : null;
  const p = input.profile ? normalize(input.profile) : null;
  const d = input.discipline ? normalize(input.discipline) : null;

  const [[tot]] = await conn.query(
    `SELECT COUNT(*) AS count FROM requirements WHERE ${effectiveRemainingExpr} > 0`
  );

  const [[afterGender]] = await conn.query(
    `
      SELECT COUNT(*) AS count
      FROM requirements
      WHERE ${effectiveRemainingExpr} > 0
        AND (? IS NULL OR LOWER(TRIM(gender)) = ?)
    `,
    [g, g]
  );

  const [[afterGenderProfile]] = await conn.query(
    `
      SELECT COUNT(*) AS count
      FROM requirements
      WHERE ${effectiveRemainingExpr} > 0
        AND (? IS NULL OR LOWER(TRIM(gender)) = ?)
        AND (? IS NULL OR LOWER(TRIM(profile)) = ?)
    `,
    [g, g, p, p]
  );

  const [[afterAllFilters]] = await conn.query(
    `
      SELECT COUNT(*) AS count
      FROM requirements
      WHERE ${effectiveRemainingExpr} > 0
        AND (? IS NULL OR LOWER(TRIM(gender)) = ?)
        AND (? IS NULL OR LOWER(TRIM(profile)) = ?)
        AND (? IS NULL OR LOWER(TRIM(discipline)) = ?)
    `,
    [g, g, p, p, d, d]
  );

  return {
    totalRowsWithRemaining: Number((tot as { count: number }).count ?? 0),
    afterGender: Number((afterGender as { count: number }).count ?? 0),
    afterGenderProfile: Number((afterGenderProfile as { count: number }).count ?? 0),
    afterAllFilters: Number((afterAllFilters as { count: number }).count ?? 0)
  };
}

/** Legacy single-pass: any zone preference may satisfy requirement.zone. */
function requirementEligible(
  candidate: Candidate,
  req: RequirementRow,
  options: EligibilityOptions
): boolean {
  if (!baseRequirementMatch(candidate, req, options)) return false;
  if (!zoneMatchesAnyPreference(candidate, req.zone)) return false;
  return businessMatchesCandidate(candidate, req.business);
}

function computeMatchDiagnostics(
  candidates: Candidate[],
  requirements: RequirementRow[],
  options: EligibilityOptions,
  useLegacyEligibility: boolean
) {
  const reqZoneNormalized = new Set(requirements.map((r) => normalize(r.zone)).filter(Boolean));
  const reqZoneKeys = new Set(
    requirements.map((r) => canonicalCardinalZone(r.zone)).filter((k): k is string => Boolean(k))
  );
  const reqBusinessSet = new Set(requirements.map((r) => normalize(r.business)).filter(Boolean));
  const reqPairs = requirements.map((r) => ({ zone: normalize(r.zone), business: normalize(r.business) }));

  let candidatesMissingAllZones = 0;
  let candidatesWithZoneOverlap = 0;
  let candidatesWithBusinessOverlap = 0;
  let fullyEligible = 0;

  const sampleCandZones = new Set<string>();
  for (const c of candidates) {
    for (const z of [c.zone1, c.zone2, c.zone3]) {
      const n = normalize(z);
      if (n) sampleCandZones.add(n);
    }
  }

  for (const c of candidates) {
    const zs = candidateZones(c);
    const zKeys = candidateZoneKeys(c);
    const bs = candidateBusinesses(c);
    if (!zs.length) candidatesMissingAllZones += 1;

    const hasZone =
      zs.some((z) => reqZoneNormalized.has(z)) ||
      zKeys.some((k) => reqZoneKeys.has(k));
    if (hasZone) candidatesWithZoneOverlap += 1;

    const hasBiz = bs.some((b) => reqBusinessSet.has(b));
    if (hasBiz) candidatesWithBusinessOverlap += 1;

    const eligible = useLegacyEligibility
      ? requirements.some((r) => requirementEligible(c, r, options))
      : candidatePotentiallyEligiblePhased(c, requirements, options);
    if (eligible) fullyEligible += 1;
  }

  const sampleReqPairs = Array.from(
    new Map(reqPairs.map((p) => [`${p.zone}|${p.business}`, p])).values()
  ).slice(0, 8);

  return {
    fullyEligibleCandidates: fullyEligible,
    candidatesMissingAllZonePreferences: candidatesMissingAllZones,
    candidatesMatchingSomeRequirementZone: candidatesWithZoneOverlap,
    candidatesMatchingSomeRequirementBusiness: candidatesWithBusinessOverlap,
    distinctRequirementZones: reqZoneNormalized.size,
    distinctRequirementBusinesses: reqBusinessSet.size,
    sampleRequirementZoneBusinessPairs: sampleReqPairs,
    sampleCandidateZoneValues: [...sampleCandZones].slice(0, 12),
    hint:
      fullyEligible === 0 && candidates.length > 0 && requirements.length > 0
        ? candidatesWithZoneOverlap === 0
          ? "No candidate zone1/2/3 matches any requirement.zone (check spelling/codes vs labels)."
          : candidatesWithBusinessOverlap === 0
            ? "Zone overlap exists but no candidate business1/2/3 matches requirement.business."
            : useLegacyEligibility
              ? "Zone and business values exist separately but no same-row (zone+business) pair matches a candidate."
              : "Phased mode: P1/P2/P3 must align with zone1/2/3 vs N/S/E/W; NP uses anywhere/flexible. Check business + HR role."
        : undefined
  };
}

/** Seat-line gender bucket for IC summary (requirement.gender). */
function genderBucketSeatLine(value: string): "male" | "female" | "other" {
  const n = normalize(value);
  if (n === "male" || n === "m") return "male";
  if (n === "female" || n === "f") return "female";
  return "other";
}

/**
 * Per IC: seats filled vs still open on this run, split by seat line gender (requirement row gender).
 */
function buildIcGenderSeatReport(
  requirements: RequirementRow[],
  assignments: Array<{ requirementId: number }>
): Array<{
  icname: string;
  maleFilled: number;
  femaleFilled: number;
  otherFilled: number;
  malePending: number;
  femalePending: number;
  otherPending: number;
  totalFilled: number;
  totalPending: number;
}> {
  const filledPerReq = new Map<number, number>();
  for (const a of assignments) {
    filledPerReq.set(a.requirementId, (filledPerReq.get(a.requirementId) ?? 0) + 1);
  }
  const icMap = new Map<
    string,
    {
      icname: string;
      maleFilled: number;
      femaleFilled: number;
      otherFilled: number;
      malePending: number;
      femalePending: number;
      otherPending: number;
    }
  >();
  const ensure = (keyNorm: string, displayIc: string) => {
    if (!icMap.has(keyNorm)) {
      icMap.set(keyNorm, {
        icname: displayIc,
        maleFilled: 0,
        femaleFilled: 0,
        otherFilled: 0,
        malePending: 0,
        femalePending: 0,
        otherPending: 0
      });
    }
    return icMap.get(keyNorm)!;
  };
  for (const r of requirements) {
    const cap = Math.max(0, r.remaining);
    const filled = Math.min(cap, filledPerReq.get(r.id) ?? 0);
    const pending = Math.max(0, cap - filled);
    const keyNorm = normalize(r.icname);
    const row = ensure(keyNorm, asText(r.icname));
    const g = genderBucketSeatLine(r.gender);
    if (g === "male") {
      row.maleFilled += filled;
      row.malePending += pending;
    } else if (g === "female") {
      row.femaleFilled += filled;
      row.femalePending += pending;
    } else {
      row.otherFilled += filled;
      row.otherPending += pending;
    }
  }
  return [...icMap.values()]
    .map((v) => ({
      ...v,
      totalFilled: v.maleFilled + v.femaleFilled + v.otherFilled,
      totalPending: v.malePending + v.femalePending + v.otherPending
    }))
    .sort((a, b) => a.icname.localeCompare(b.icname));
}

function sumIcGenderSeatReport(
  rows: ReturnType<typeof buildIcGenderSeatReport>
): {
  maleFilled: number;
  femaleFilled: number;
  otherFilled: number;
  malePending: number;
  femalePending: number;
  otherPending: number;
  totalFilled: number;
  totalPending: number;
} {
  const z = {
    maleFilled: 0,
    femaleFilled: 0,
    otherFilled: 0,
    malePending: 0,
    femalePending: 0,
    otherPending: 0,
    totalFilled: 0,
    totalPending: 0
  };
  for (const r of rows) {
    z.maleFilled += r.maleFilled;
    z.femaleFilled += r.femaleFilled;
    z.otherFilled += r.otherFilled;
    z.malePending += r.malePending;
    z.femalePending += r.femalePending;
    z.otherPending += r.otherPending;
    z.totalFilled += r.totalFilled;
    z.totalPending += r.totalPending;
  }
  return z;
}

function buildPendingPerRequirementId(
  requirements: RequirementRow[],
  assignments: Array<{ requirementId: number }>
): Map<number, number> {
  const filledPerReq = new Map<number, number>();
  for (const a of assignments) {
    filledPerReq.set(a.requirementId, (filledPerReq.get(a.requirementId) ?? 0) + 1);
  }
  const m = new Map<number, number>();
  for (const r of requirements) {
    const cap = Math.max(0, r.remaining);
    const f = Math.min(cap, filledPerReq.get(r.id) ?? 0);
    m.set(r.id, Math.max(0, cap - f));
  }
  return m;
}

function strictEligibleForOpenSeat(
  c: Candidate,
  req: RequirementRow,
  pendingByReqId: Map<number, number>,
  hrOptions: EligibilityOptions,
  useLegacy: boolean
): boolean {
  if ((pendingByReqId.get(req.id) ?? 0) <= 0) return false;
  if (useLegacy) return requirementEligible(c, req, hrOptions);
  return PREFERENCE_PHASES.some((ph) => requirementEligibleForPhase(c, req, hrOptions, ph));
}

/** Open seat at IC: only seat gender differs; profile/discipline/legacy/HR strict + zone + business OK. */
function genderRelaxWouldMatchOpenSeat(
  c: Candidate,
  req: RequirementRow,
  pendingByReqId: Map<number, number>,
  hrOptions: EligibilityOptions,
  useLegacy: boolean
): boolean {
  if (hrOptions.ignoreGender) return false;
  if ((pendingByReqId.get(req.id) ?? 0) <= 0) return false;
  if (normalize(c.gender) === normalize(req.gender)) return false;
  if (normalize(c.profile) !== normalize(req.profile)) return false;
  if (normalize(c.discipline) !== normalize(req.discipline)) return false;
  if (!legacyAllocatedRoleMatches(c, req)) return false;
  if (!hrRoleSuitabilityMatches(c, req, hrOptions.ignoreRoleSuitability)) return false;
  if (!businessMatchesCandidate(c, req.business)) return false;
  if (useLegacy) return zoneMatchesAnyPreference(c, req.zone);
  return PREFERENCE_PHASES.some((ph) => zoneMatchesPreferencePhase(c, req.zone, ph));
}

/** Open seat: seat gender matches; HR strict fails; profile/discipline/legacy + zone + business OK. */
function hrRelaxWouldMatchOpenSeat(
  c: Candidate,
  req: RequirementRow,
  pendingByReqId: Map<number, number>,
  useLegacy: boolean,
  eligibility: EligibilityOptions
): boolean {
  if ((pendingByReqId.get(req.id) ?? 0) <= 0) return false;
  if (!eligibility.ignoreGender && normalize(c.gender) !== normalize(req.gender)) return false;
  if (normalize(c.profile) !== normalize(req.profile)) return false;
  if (normalize(c.discipline) !== normalize(req.discipline)) return false;
  if (!legacyAllocatedRoleMatches(c, req)) return false;
  if (hrRoleSuitabilityMatches(c, req, false)) return false;
  if (!businessMatchesCandidate(c, req.business)) return false;
  if (useLegacy) return zoneMatchesAnyPreference(c, req.zone);
  return PREFERENCE_PHASES.some((ph) => zoneMatchesPreferencePhase(c, req.zone, ph));
}

/** Strict HR+gender+profile+discipline+legacy OK, but zone/business rules block this seat line. */
function zoneOrBusinessMismatchOnOpenSeat(
  c: Candidate,
  req: RequirementRow,
  pendingByReqId: Map<number, number>,
  opts: EligibilityOptions,
  useLegacy: boolean
): boolean {
  if ((pendingByReqId.get(req.id) ?? 0) <= 0) return false;
  if (!baseRequirementMatch(c, req, opts)) return false;
  if (useLegacy) {
    return !zoneMatchesAnyPreference(c, req.zone) || !businessMatchesCandidate(c, req.business);
  }
  if (!businessMatchesCandidate(c, req.business)) return true;
  return !PREFERENCE_PHASES.some((ph) => zoneMatchesPreferencePhase(c, req.zone, ph));
}

function hasProfileDisciplineOverlapOnPendingRowsAtIc(
  c: Candidate,
  rows: RequirementRow[],
  pendingByReqId: Map<number, number>
): boolean {
  return rows.some(
    (r) =>
      (pendingByReqId.get(r.id) ?? 0) > 0 &&
      normalize(c.profile) === normalize(r.profile) &&
      normalize(c.discipline) === normalize(r.discipline)
  );
}

/**
 * For each IC with still-open seats: classify each unassigned candidate at most once (priority order)
 * against that IC's pending rows only.
 */
function buildUnassignedIcInsights(
  candidates: Candidate[],
  assignments: Assignment[],
  requirements: RequirementRow[],
  hrOptions: EligibilityOptions,
  useLegacyEligibility: boolean
): {
  unassignedCount: number;
  note: string;
  rows: Array<{
    icname: string;
    openSeatsPending: number;
    strictEligibleUnassigned: number;
    blockedGenderMismatchOnly: number;
    blockedHrRoleMismatchOnly: number;
    blockedZoneOrBusinessMismatch: number;
    profileDisciplineNoMatchingSeatLineAtIc: number;
    otherAtIc: number;
  }>;
  totals: {
    openSeatsPending: number;
    strictEligibleUnassigned: number;
    blockedGenderMismatchOnly: number;
    blockedHrRoleMismatchOnly: number;
    blockedZoneOrBusinessMismatch: number;
    profileDisciplineNoMatchingSeatLineAtIc: number;
    otherAtIc: number;
  };
} {
  const pendingByReqId = buildPendingPerRequirementId(requirements, assignments);
  const assignedIds = new Set(assignments.map((a) => a.candidateId));
  const unassigned = candidates.filter((c) => !assignedIds.has(c.id));

  const icKeys = new Set(requirements.map((r) => normalize(r.icname)).filter(Boolean));
  const rowsByIc = new Map<string, RequirementRow[]>();
  for (const r of requirements) {
    const k = normalize(r.icname);
    if (!k) continue;
    if (!rowsByIc.has(k)) rowsByIc.set(k, []);
    rowsByIc.get(k)!.push(r);
  }

  const out: Array<{
    icname: string;
    openSeatsPending: number;
    strictEligibleUnassigned: number;
    blockedGenderMismatchOnly: number;
    blockedHrRoleMismatchOnly: number;
    blockedZoneOrBusinessMismatch: number;
    profileDisciplineNoMatchingSeatLineAtIc: number;
    otherAtIc: number;
  }> = [];

  const totals = {
    openSeatsPending: 0,
    strictEligibleUnassigned: 0,
    blockedGenderMismatchOnly: 0,
    blockedHrRoleMismatchOnly: 0,
    blockedZoneOrBusinessMismatch: 0,
    profileDisciplineNoMatchingSeatLineAtIc: 0,
    otherAtIc: 0
  };

  for (const k of [...icKeys].sort()) {
    const icRows = rowsByIc.get(k) ?? [];
    const openSeatsPending = icRows.reduce((s, r) => s + (pendingByReqId.get(r.id) ?? 0), 0);
    if (openSeatsPending <= 0) continue;

    const displayIc = icRows[0] ? asText(icRows[0].icname) : k;
    const pendingRows = icRows.filter((r) => (pendingByReqId.get(r.id) ?? 0) > 0);

    let strictEligibleUnassigned = 0;
    let blockedGenderMismatchOnly = 0;
    let blockedHrRoleMismatchOnly = 0;
    let blockedZoneOrBusinessMismatch = 0;
    let profileDisciplineNoMatchingSeatLineAtIc = 0;
    let otherAtIc = 0;

    for (const c of unassigned) {
      if (pendingRows.some((req) => strictEligibleForOpenSeat(c, req, pendingByReqId, hrOptions, useLegacyEligibility))) {
        strictEligibleUnassigned += 1;
        continue;
      }
      if (pendingRows.some((req) => genderRelaxWouldMatchOpenSeat(c, req, pendingByReqId, hrOptions, useLegacyEligibility))) {
        blockedGenderMismatchOnly += 1;
        continue;
      }
      if (pendingRows.some((req) => hrRelaxWouldMatchOpenSeat(c, req, pendingByReqId, useLegacyEligibility, hrOptions))) {
        blockedHrRoleMismatchOnly += 1;
        continue;
      }
      if (
        pendingRows.some((req) => zoneOrBusinessMismatchOnOpenSeat(c, req, pendingByReqId, hrOptions, useLegacyEligibility))
      ) {
        blockedZoneOrBusinessMismatch += 1;
        continue;
      }
      if (!hasProfileDisciplineOverlapOnPendingRowsAtIc(c, pendingRows, pendingByReqId)) {
        profileDisciplineNoMatchingSeatLineAtIc += 1;
        continue;
      }
      otherAtIc += 1;
    }

    out.push({
      icname: displayIc,
      openSeatsPending,
      strictEligibleUnassigned,
      blockedGenderMismatchOnly,
      blockedHrRoleMismatchOnly,
      blockedZoneOrBusinessMismatch,
      profileDisciplineNoMatchingSeatLineAtIc,
      otherAtIc
    });
    totals.openSeatsPending += openSeatsPending;
    totals.strictEligibleUnassigned += strictEligibleUnassigned;
    totals.blockedGenderMismatchOnly += blockedGenderMismatchOnly;
    totals.blockedHrRoleMismatchOnly += blockedHrRoleMismatchOnly;
    totals.blockedZoneOrBusinessMismatch += blockedZoneOrBusinessMismatch;
    totals.profileDisciplineNoMatchingSeatLineAtIc += profileDisciplineNoMatchingSeatLineAtIc;
    totals.otherAtIc += otherAtIc;
  }

  const sorted = out.sort((a, b) => a.icname.localeCompare(b.icname));
  const baseNote =
    "Per IC with open seats: each unassigned person is classified once (priority below). The same person is counted again on every other IC that still has open seats, so the totals row sums person×IC tallies and can be much larger than Unassigned (unique people). Priority: (1) eligible for an open line here but not picked — merit / order / caps; (2) only seat gender blocks; (3) only HR role blocks (gender+profile+discipline+zone+business OK vs some open line, but Panel HR strict fails); (4) zone or business vs seat line; (5) no open line shares profile+discipline; (6) other.";

  if (!sorted.length && unassigned.length > 0) {
    return {
      unassignedCount: unassigned.length,
      note:
        baseNote +
        " There is no IC with open seats left in this filtered slice, so the table is empty — remaining unassigned people had no seat capacity to claim here.",
      rows: [],
      totals
    };
  }

  return {
    unassignedCount: unassigned.length,
    note: baseNote,
    rows: sorted,
    totals
  };
}

type UnassignedReasonCode = "NEVER_ELIGIBLE" | "ELIGIBLE_CAPACITY_OR_MERIT";

function isCandidateEligibleForRun(
  c: Candidate,
  requirements: RequirementRow[],
  hrOptions: EligibilityOptions,
  useLegacy: boolean
): boolean {
  if (useLegacy) {
    return requirements.some((r) => requirementEligible(c, r, hrOptions));
  }
  return candidatePotentiallyEligiblePhased(c, requirements, hrOptions);
}

function computeUnassignedSummary(
  candidates: Candidate[],
  assignments: Assignment[],
  requirements: RequirementRow[],
  hrOptions: EligibilityOptions,
  opts: {
    totalSlots: number;
    skippedNoCandidate: number;
    skippedDueToIcCap: number;
    useLegacyEligibility: boolean;
  }
) {
  const assignedIds = new Set(assignments.map((a) => a.candidateId));
  const unassignedList = candidates.filter((c) => !assignedIds.has(c.id));

  let neverEligible = 0;
  let eligibleButNotAssigned = 0;

  for (const c of unassignedList) {
    const anyRow = isCandidateEligibleForRun(c, requirements, hrOptions, opts.useLegacyEligibility);
    if (!anyRow) neverEligible += 1;
    else eligibleButNotAssigned += 1;
  }

  const lines = [
    `Total unassigned: ${unassignedList.length}.`,
    neverEligible > 0
      ? `${neverEligible}: no requirement row matched (discipline/profile${
          hrOptions.ignoreGender ? "" : "/gender"
        }/business/HR role + ${opts.useLegacyEligibility ? "any zone preference" : "P1/P2/P3/NP zone rules"}${
          hrOptions.ignoreGender ? "; gender not enforced" : ""
        }).`
      : null,
    eligibleButNotAssigned > 0
      ? `${eligibleButNotAssigned}: matched at least one requirement row but did not get a seat — usually fewer slots than eligible candidates, higher merit/suggested_ic won, or slots skipped (empty: ${opts.skippedNoCandidate}, IC cap: ${opts.skippedDueToIcCap}).`
      : null,
    opts.totalSlots < unassignedList.length && eligibleButNotAssigned > 0
      ? `Total seats this run: ${opts.totalSlots}; candidates considered: ${candidates.length}.`
      : null
  ].filter(Boolean);

  return {
    totalUnassigned: unassignedList.length,
    neverEligibleForAnyRequirement: neverEligible,
    eligibleButNotAssigned: eligibleButNotAssigned,
    totalSlotsInRun: opts.totalSlots,
    skippedSlotsNoCandidate: opts.skippedNoCandidate,
    skippedSlotsDueToIcCap: opts.skippedDueToIcCap,
    explanation: lines.join(" ")
  };
}

const UNASSIGNED_PHASED_NEVER_BULLETS = [
  "Gender, profile, and discipline must match a requirement row (same as the seat line).",
  "Business: at least one of business1 / business2 / business3 must match requirement.business.",
  "P1 round: only candidate zone1 is compared to requirement zone (North / South / East / West after normalization).",
  "P2 round: only zone2 vs requirement zone.",
  "P3 round: only zone3 vs requirement zone.",
  "NP round: “Anywhere” / flexible text OR any of zone1–3 may match requirement zone.",
  "When “Ignore Panel HR role suggested” is off: candidate_suitable must not be empty; if requirement.role_name is set, it must match candidate_suitable."
];

const UNASSIGNED_LEGACY_NEVER_BULLETS = [
  "Gender, profile, and discipline must match a requirement row.",
  "At least one of zone1 / zone2 / zone3 must match requirement.zone (including N/S/E/W).",
  "At least one of business1 / business2 / business3 must match requirement.business.",
  "When “Ignore Panel HR role suggested” is off: candidate_suitable must not be empty; if requirement.role_name is set, it must match candidate_suitable."
];

const UNASSIGNED_ELIGIBLE_BULLETS = [
  "This candidate could sit in at least one open seat under the rules, but did not receive one in this run.",
  "Usually: fewer seats than eligible people, so higher merit (and optional suggested-IC preference) wins.",
  "Some slots may have been skipped (no eligible pick at that step, or max-per-IC cap)."
];

function neverEligibleDetailBullets(useLegacyEligibility: boolean, ignoreGender: boolean): string[] {
  if (useLegacyEligibility) {
    const b = [...UNASSIGNED_LEGACY_NEVER_BULLETS];
    if (ignoreGender) {
      b[0] = "Profile and discipline must match a requirement row; gender was not enforced for this run.";
    }
    return b;
  }
  const b = [...UNASSIGNED_PHASED_NEVER_BULLETS];
  if (ignoreGender) {
    b[0] =
      "Profile and discipline must match a requirement row; gender was not enforced (seat lines may still carry M/F in data).";
  }
  return b;
}

function buildUnassignedDetails(
  candidates: Candidate[],
  assignments: Assignment[],
  requirements: RequirementRow[],
  hrOptions: EligibilityOptions,
  useLegacyEligibility: boolean,
  limit: number
): Array<{
  candidateId: number;
  email: string;
  meritscore: number;
  reasonCode: UnassignedReasonCode;
  detail: string;
  detailBullets: string[];
  profile?: string;
  discipline?: string;
  gender?: string;
  zone1?: string;
  zone2?: string;
  zone3?: string;
  business1?: string;
  business2?: string;
  business3?: string;
  permanentZone?: string;
  permanentState?: string;
  sameAsP1?: boolean | null;
  candidateSuitable?: string | null;
  suggestedIc?: string | null;
}> {
  const assignedIds = new Set(assignments.map((a) => a.candidateId));
  const unassignedList = candidates.filter((c) => !assignedIds.has(c.id));
  const out: Array<{
    candidateId: number;
    email: string;
    meritscore: number;
    reasonCode: UnassignedReasonCode;
    detail: string;
    detailBullets: string[];
    profile?: string;
    discipline?: string;
    gender?: string;
    zone1?: string;
    zone2?: string;
    zone3?: string;
    business1?: string;
    business2?: string;
    business3?: string;
    permanentZone?: string;
    permanentState?: string;
    sameAsP1?: boolean | null;
    candidateSuitable?: string | null;
    suggestedIc?: string | null;
  }> = [];

  for (const c of unassignedList) {
    if (out.length >= limit) break;
    const anyRow = isCandidateEligibleForRun(c, requirements, hrOptions, useLegacyEligibility);
    if (!anyRow) {
      out.push({
        candidateId: c.id,
        email: c.email,
        meritscore: c.meritscore,
        reasonCode: "NEVER_ELIGIBLE",
        detail: useLegacyEligibility
          ? "No requirement seat matches this candidate (legacy any-zone rules)."
          : "No requirement seat matches this candidate under phased P1→P2→P3→NP rules.",
        detailBullets: neverEligibleDetailBullets(useLegacyEligibility, hrOptions.ignoreGender),
        profile: asText(c.profile),
        discipline: asText(c.discipline),
        gender: asText(c.gender),
        zone1: asText(c.zone1),
        zone2: asText(c.zone2),
        zone3: asText(c.zone3),
        business1: asText(c.business1),
        business2: asText(c.business2),
        business3: asText(c.business3),
        permanentZone: asText(c.permanent_zone ?? ""),
        permanentState: asText(c.permanent_state ?? ""),
        sameAsP1: sameAsP1(c),
        candidateSuitable: normalize(c.candidate_suitable ?? "") ? asText(c.candidate_suitable) : null,
        suggestedIc: normalize(c.suggested_ic ?? "") ? asText(c.suggested_ic) : null
      });
    } else {
      out.push({
        candidateId: c.id,
        email: c.email,
        meritscore: c.meritscore,
        reasonCode: "ELIGIBLE_CAPACITY_OR_MERIT",
        detail: "Eligible for at least one seat but not assigned in this run.",
        detailBullets: [...UNASSIGNED_ELIGIBLE_BULLETS],
        profile: asText(c.profile),
        discipline: asText(c.discipline),
        gender: asText(c.gender),
        zone1: asText(c.zone1),
        zone2: asText(c.zone2),
        zone3: asText(c.zone3),
        business1: asText(c.business1),
        business2: asText(c.business2),
        business3: asText(c.business3),
        permanentZone: asText(c.permanent_zone ?? ""),
        permanentState: asText(c.permanent_state ?? ""),
        sameAsP1: sameAsP1(c),
        candidateSuitable: normalize(c.candidate_suitable ?? "") ? asText(c.candidate_suitable) : null,
        suggestedIc: normalize(c.suggested_ic ?? "") ? asText(c.suggested_ic) : null
      });
    }
  }

  return out;
}

type PickOptions = { preferSuggestedIc: boolean } & EligibilityOptions;

function pickCandidateForReq(
  candidates: Candidate[],
  req: RequirementRow,
  taken: Set<number>,
  options: PickOptions,
  phase?: PreferencePhase
): {
  candidate: Candidate;
  suggestedIcMatch: boolean;
  eligiblePoolSize: number;
  eligibleRank: number;
  topEligibleCandidateId: number | null;
  topEligibleCandidateEmail: string | null;
} | null {
  const eligible: Candidate[] = [];
  for (const c of candidates) {
    if (taken.has(c.id)) continue;
    const ok =
      phase === undefined
        ? requirementEligible(c, req, options)
        : requirementEligibleForPhase(c, req, options, phase);
    if (ok) eligible.push(c);
  }
  if (!eligible.length) return null;
  if (options.preferSuggestedIc) {
    const preferred = eligible.filter((c) => suggestedIcMatchesRequirement(c, req));
    const chosen = (preferred.length ? preferred : eligible)[0];
    const fullRank = eligible.findIndex((c) => c.id === chosen.id) + 1;
    return {
      candidate: chosen,
      suggestedIcMatch: Boolean(normalize(chosen.suggested_ic ?? "")) && suggestedIcMatchesRequirement(chosen, req),
      eligiblePoolSize: eligible.length,
      eligibleRank: fullRank || 1,
      topEligibleCandidateId: eligible[0]?.id ?? null,
      topEligibleCandidateEmail: eligible[0] ? asText(eligible[0].email) : null
    };
  }
  const chosen = eligible[0];
  return {
    candidate: chosen,
    /** When preference is off, merit-only pick — do not show Yes (avoids implying HR suggested-IC was applied). */
    suggestedIcMatch: false,
    eligiblePoolSize: eligible.length,
    eligibleRank: 1,
    topEligibleCandidateId: chosen.id,
    topEligibleCandidateEmail: asText(chosen.email)
  };
}

async function persistAssignment(
  conn: PoolConnection,
  req: RequirementRow,
  candidate: Candidate,
  businessPriorityLabel: string
): Promise<void> {
  await conn.query("UPDATE requirements SET allocated = allocated + 1 WHERE id = ? AND remaining > 0", [req.id]);
  await conn.query(
    "UPDATE candidates SET allocated_zone = ?, allocated_business = ?, allocated_ic = ? WHERE id = ?",
    [req.zone, req.business, req.icname, candidate.id]
  );
  await conn.query(
    `
      INSERT INTO logs_business
      (gender, profile, discipline, zone, business_priority, business, icname, email, meritscore)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [req.gender, req.profile, req.discipline, req.zone, businessPriorityLabel, req.business, req.icname, candidate.email, candidate.meritscore]
  );
}

type HrPickOptions = PickOptions;

async function runPhasedAllocationRound(args: {
  conn: PoolConnection;
  mode: AllocationMode;
  candidates: Candidate[];
  requirements: RequirementRow[];
  effectiveZoneOrder: string[];
  seqBusinessRaw: string[] | null;
  rem: Map<number, number>;
  taken: Set<number>;
  assignments: Assignment[];
  perIcCount: Map<string, number>;
  maxPerIc: number | undefined;
  hrOptions: HrPickOptions;
  hrRelaxedSecondPass: boolean;
  genderRelaxedThirdPass: boolean;
}): Promise<{ skippedNoCandidate: number; skippedDueToIcCap: number }> {
  const {
    conn,
    mode,
    candidates,
    requirements,
    effectiveZoneOrder,
    seqBusinessRaw,
    rem,
    taken,
    assignments,
    perIcCount,
    maxPerIc,
    hrOptions,
    hrRelaxedSecondPass,
    genderRelaxedThirdPass
  } = args;
  const icKey = (ic: string) => normalize(ic);
  const ignoreHr = hrOptions.ignoreRoleSuitability;
  let skippedNoCandidate = 0;
  let skippedDueToIcCap = 0;

  for (const phase of PREFERENCE_PHASES) {
    for (const zoneKey of effectiveZoneOrder) {
      let rowsForZone = requirements.filter(
        (r) => canonicalCardinalZone(r.zone) === zoneKey && (rem.get(r.id) ?? 0) > 0
      );
      if (!rowsForZone.length) continue;
      rowsForZone = sortRequirementsBySeqBusiness(rowsForZone, seqBusinessRaw);

      const slots = rowsForZone.flatMap((r) => Array.from({ length: rem.get(r.id) ?? 0 }, () => r));
      const n = slots.length;
      for (let i = 0; i < n; i += 1) {
        const req = slots[zigZagIndex(i, n)];
        const key = icKey(req.icname);
        if (maxPerIc !== undefined && (perIcCount.get(key) ?? 0) >= maxPerIc) {
          skippedDueToIcCap += 1;
          continue;
        }
        const picked = pickCandidateForReq(candidates, req, taken, hrOptions, phase);
        if (!picked) {
          skippedNoCandidate += 1;
          continue;
        }
        const {
          candidate,
          suggestedIcMatch,
          eligiblePoolSize,
          eligibleRank,
          topEligibleCandidateId,
          topEligibleCandidateEmail
        } = picked;
        taken.add(candidate.id);
        perIcCount.set(key, (perIcCount.get(key) ?? 0) + 1);
        const reqRemainingBefore = rem.get(req.id) ?? 0;
        rem.set(req.id, Math.max(0, (rem.get(req.id) ?? 0) - 1));
        const reqRemainingAfter = rem.get(req.id) ?? 0;
        const roleSuitability = classifyRoleSuitability(candidate, req, ignoreHr);
        assignments.push({
          requirementId: req.id,
          candidateId: candidate.id,
          email: candidate.email,
          meritscore: candidate.meritscore,
          profile: asText(candidate.profile),
          discipline: asText(candidate.discipline),
          gender: asText(candidate.gender),
          zone: req.zone,
          business: req.business,
          icname: asText(req.icname),
          suggestedIcMatch,
          suggestedIc: asText(candidate.suggested_ic ?? ""),
          servicePreferences: candidateServicePreferences(candidate),
          requirementRoleName: normalize(req.role_name ?? "") ? asText(req.role_name) : null,
          candidateSuitable: normalize(candidate.candidate_suitable ?? "") ? asText(candidate.candidate_suitable) : null,
          roleSuitability,
          preferencePhase: phase,
          zone1: asText(candidate.zone1),
          zone2: asText(candidate.zone2),
          zone3: asText(candidate.zone3),
          business1: asText(candidate.business1),
          business2: asText(candidate.business2),
          business3: asText(candidate.business3),
          eligibilityVerdict: "MATCHED",
          zoneMatchBasis: zoneMatchBasisForPhase(candidate, req, phase),
          businessMatchBasis: businessMatchBasis(candidate, req),
          eligiblePoolSize,
          eligibleRank,
          topEligibleCandidateId,
          topEligibleCandidateEmail,
          requirementRemainingBefore: reqRemainingBefore,
          requirementRemainingAfter: reqRemainingAfter,
          permanentZone: asText(candidate.permanent_zone ?? ""),
          permanentState: asText(candidate.permanent_state ?? ""),
          sameAsP1: sameAsP1(candidate),
          requirementGender: asText(req.gender),
          ...(hrRelaxedSecondPass ? { hrRelaxedSecondPass: true } : {}),
          ...(genderRelaxedThirdPass ? { genderRelaxedThirdPass: true } : {})
        });
        if (mode === "run") {
          await persistAssignment(conn, req, candidate, phase);
        }
      }
    }
  }
  return { skippedNoCandidate, skippedDueToIcCap };
}

async function runLegacyAllocationRound(args: {
  conn: PoolConnection;
  mode: AllocationMode;
  candidates: Candidate[];
  sortedLegacyReqs: RequirementRow[];
  rem: Map<number, number>;
  taken: Set<number>;
  assignments: Assignment[];
  perIcCount: Map<string, number>;
  maxPerIc: number | undefined;
  hrOptions: HrPickOptions;
  hrRelaxedSecondPass: boolean;
  genderRelaxedThirdPass: boolean;
}): Promise<{ skippedNoCandidate: number; skippedDueToIcCap: number }> {
  const {
    conn,
    mode,
    candidates,
    sortedLegacyReqs,
    rem,
    taken,
    assignments,
    perIcCount,
    maxPerIc,
    hrOptions,
    hrRelaxedSecondPass,
    genderRelaxedThirdPass
  } = args;
  const icKey = (ic: string) => normalize(ic);
  const ignoreHr = hrOptions.ignoreRoleSuitability;
  let skippedNoCandidate = 0;
  let skippedDueToIcCap = 0;

  const requirementSlots = sortedLegacyReqs.flatMap((r) =>
    Array.from({ length: Math.max(rem.get(r.id) ?? 0, 0) }, () => r)
  );
  const n = requirementSlots.length;
  for (let i = 0; i < n; i += 1) {
    const req = requirementSlots[zigZagIndex(i, n)];
    const key = icKey(req.icname);
    if (maxPerIc !== undefined && (perIcCount.get(key) ?? 0) >= maxPerIc) {
      skippedDueToIcCap += 1;
      continue;
    }
    const picked = pickCandidateForReq(candidates, req, taken, hrOptions);
    if (!picked) {
      skippedNoCandidate += 1;
      continue;
    }
    const {
      candidate,
      suggestedIcMatch,
      eligiblePoolSize,
      eligibleRank,
      topEligibleCandidateId,
      topEligibleCandidateEmail
    } = picked;
    taken.add(candidate.id);
    perIcCount.set(key, (perIcCount.get(key) ?? 0) + 1);
    const reqRemainingBefore = rem.get(req.id) ?? 0;
    rem.set(req.id, Math.max(0, reqRemainingBefore - 1));
    const reqRemainingAfter = rem.get(req.id) ?? 0;
    const roleSuitability = classifyRoleSuitability(candidate, req, ignoreHr);
    assignments.push({
      requirementId: req.id,
      candidateId: candidate.id,
      email: candidate.email,
      meritscore: candidate.meritscore,
      profile: asText(candidate.profile),
      discipline: asText(candidate.discipline),
      gender: asText(candidate.gender),
      zone: req.zone,
      business: req.business,
      icname: asText(req.icname),
      suggestedIcMatch,
      suggestedIc: asText(candidate.suggested_ic ?? ""),
      servicePreferences: candidateServicePreferences(candidate),
      requirementRoleName: normalize(req.role_name ?? "") ? asText(req.role_name) : null,
      candidateSuitable: normalize(candidate.candidate_suitable ?? "") ? asText(candidate.candidate_suitable) : null,
      roleSuitability,
      preferencePhase: "ANY",
      zone1: asText(candidate.zone1),
      zone2: asText(candidate.zone2),
      zone3: asText(candidate.zone3),
      business1: asText(candidate.business1),
      business2: asText(candidate.business2),
      business3: asText(candidate.business3),
      eligibilityVerdict: "MATCHED",
      zoneMatchBasis: zoneMatchBasisForPhase(candidate, req, "ANY"),
      businessMatchBasis: businessMatchBasis(candidate, req),
      eligiblePoolSize,
      eligibleRank,
      topEligibleCandidateId,
      topEligibleCandidateEmail,
      requirementRemainingBefore: reqRemainingBefore,
      requirementRemainingAfter: reqRemainingAfter,
      permanentZone: asText(candidate.permanent_zone ?? ""),
      permanentState: asText(candidate.permanent_state ?? ""),
      sameAsP1: sameAsP1(candidate),
      requirementGender: asText(req.gender),
      ...(hrRelaxedSecondPass ? { hrRelaxedSecondPass: true } : {}),
      ...(genderRelaxedThirdPass ? { genderRelaxedThirdPass: true } : {})
    });
    if (mode === "run") {
      await persistAssignment(conn, req, candidate, "AUTO");
    }
  }
  return { skippedNoCandidate, skippedDueToIcCap };
}

export async function executeAllocation(mode: AllocationMode, rawInput: unknown) {
  const parsed = requestSchema.parse(rawInput ?? {});
  const useLegacyTwoPhaseScript = Boolean(
    parsed.useLegacyTwoPhaseScript ?? parsed.filters?.useLegacyTwoPhaseScript
  );
  const input: AllocationInput = {
    gender: parsed.gender ?? parsed.filters?.gender,
    profile: parsed.profile ?? parsed.filters?.profile,
    discipline: parsed.discipline ?? parsed.filters?.discipline,
    resetBeforeRun: parsed.resetBeforeRun ?? parsed.filters?.resetBeforeRun,
    includeTrace: parsed.includeTrace ?? parsed.filters?.includeTrace,
    maxPerIc: parsed.maxPerIc ?? parsed.filters?.maxPerIc,
    preferSuggestedIc: parsed.preferSuggestedIc ?? parsed.filters?.preferSuggestedIc,
    ignoreRoleSuitability: parsed.ignoreRoleSuitability ?? parsed.filters?.ignoreRoleSuitability,
    ignoreGender: parsed.ignoreGender ?? parsed.filters?.ignoreGender,
    hrRelaxUnassignedSecondPass:
      parsed.hrRelaxUnassignedSecondPass ?? parsed.filters?.hrRelaxUnassignedSecondPass,
    genderRelaxUnassignedThirdPass:
      parsed.genderRelaxUnassignedThirdPass ?? parsed.filters?.genderRelaxUnassignedThirdPass,
    includeUnassignedLog: parsed.includeUnassignedLog ?? parsed.filters?.includeUnassignedLog,
    phasedPreference: parsed.phasedPreference ?? parsed.filters?.phasedPreference,
    useLegacyTwoPhaseScript
  };
  return withTransaction(async (conn) => {
    const simulateFromFresh = mode === "simulate" && Boolean(input.resetBeforeRun);
    const includeTrace = Boolean(input.includeTrace);

    if (useLegacyTwoPhaseScript) {
      if (mode === "run" && input.resetBeforeRun) {
        await conn.query(
          "UPDATE candidates SET allocated_zone = NULL, allocated_business = NULL, allocated_ic = NULL WHERE isManual = 0"
        );
        await conn.query("UPDATE requirements SET allocated = 0");
        try {
          await conn.query("UPDATE requirements_zone_calculated SET allocated = 0");
        } catch {
          /* table may be absent until DBA creates it */
        }
        await conn.query("TRUNCATE TABLE logs_business");
        await conn.query("TRUNCATE TABLE logs_zone");
      }
      return executeLegacyTwoPhaseScript(conn, mode, input, {
        simulateFromFresh,
        includeTrace,
        includeUnassignedLog: Boolean(input.includeUnassignedLog)
      });
    }
    const maxPerIc = input.maxPerIc;
    const preferSuggestedIc = input.preferSuggestedIc !== false;
    const ignoreRoleSuitability = Boolean(input.ignoreRoleSuitability);
    const ignoreGender = Boolean(input.ignoreGender);
    const usePhasedAllocation = input.phasedPreference !== false;
    const useLegacyEligibility = !usePhasedAllocation;
    const hrOptions: HrPickOptions = { preferSuggestedIc, ignoreRoleSuitability, ignoreGender };
    const trace: Array<{ step: string; detail?: Record<string, unknown> }> = [];

    const pushTrace = (step: string, detail?: Record<string, unknown>) => {
      if (includeTrace) trace.push(detail ? { step, detail } : { step });
    };

    pushTrace("start", {
      mode,
      simulateFromFresh,
      allocationStrategy: usePhasedAllocation ? "P1→P2→P3→NP per N,S,E,W (EduTech)" : "legacy_any_zone",
      maxPerIc: maxPerIc ?? null,
      preferSuggestedIc,
      ignoreRoleSuitability,
      ignoreGender,
      hrRelaxUnassignedSecondPass: Boolean(input.hrRelaxUnassignedSecondPass),
      genderRelaxUnassignedThirdPass: Boolean(input.genderRelaxUnassignedThirdPass),
      filters: {
        gender: input.gender ?? null,
        profile: input.profile ?? null,
        discipline: input.discipline ?? null
      }
    });

    if (mode === "run" && input.resetBeforeRun) {
      await conn.query("UPDATE candidates SET allocated_zone = NULL, allocated_business = NULL, allocated_ic = NULL WHERE isManual = 0");
      await conn.query("UPDATE requirements SET allocated = 0");
      await conn.query("TRUNCATE TABLE logs_business");
      await conn.query("TRUNCATE TABLE logs_zone");
      pushTrace("reset_database_state", { clearedNonManualAllocations: true, truncatedLogs: true });
    }

    const requirements = await loadRequirements(conn, input, { simulateFromFresh });
    const seqZoneRaw = await loadSeqZoneOrder(conn);
    const seqBusinessRaw = await loadSeqBusinessOrder(conn);
    const effectiveZoneOrder = buildEffectiveZoneOrder(seqZoneRaw, requirements);
    pushTrace("load_requirements", {
      rows: requirements.length,
      capacitySource: simulateFromFresh ? "newvalue (fresh simulate)" : "remaining"
    });
    pushTrace("sequence_tables", {
      seq_zone_order: seqZoneRaw,
      seq_business_order: seqBusinessRaw,
      effective_zone_iteration_order: effectiveZoneOrder
    });

    const candidates = await loadCandidates(conn, input, { simulateFromFresh });
    pushTrace("load_candidates", {
      count: candidates.length,
      unallocatedOnly: !simulateFromFresh
    });

    const requirementDiagnostics = await getRequirementDiagnostics(conn, input, { simulateFromFresh });
    const matchDiagnostics = computeMatchDiagnostics(
      candidates,
      requirements,
      { ignoreRoleSuitability, ignoreGender },
      useLegacyEligibility
    );
    const requirementProfilesCatalog = await loadRequirementProfilesCatalog(conn, input);
    const profilesMissingRequirements: ProfileWithoutRequirements[] = computeProfilesMissingRequirements(
      candidates,
      requirementProfilesCatalog
    );
    pushTrace("diagnostics", {
      requirementDiagnostics,
      matchDiagnostics,
      profilesMissingRequirementsCount: profilesMissingRequirements.length
    });

    const initialTotalCapacity = requirements.reduce((s, r) => s + Math.max(r.remaining, 0), 0);

    const taken = new Set<number>();
    const assignments: Assignment[] = [];
    let skippedNoCandidate = 0;
    let skippedDueToIcCap = 0;
    const perIcCount = new Map<string, number>();

    const icKey = (ic: string) => normalize(ic);

    let legacyTotalSlotIterations: number | undefined;
    const hrRelaxRequested = Boolean(input.hrRelaxUnassignedSecondPass);
    const hrRelaxExecuted = hrRelaxRequested && !ignoreRoleSuitability;
    const genderRelaxRequested = Boolean(input.genderRelaxUnassignedThirdPass);
    const genderRelaxExecuted = genderRelaxRequested && !ignoreGender;
    let secondPassRan = false;
    let secondPassSkippedNoCandidate = 0;
    let secondPassSkippedDueToIcCap = 0;
    let thirdPassRan = false;
    let thirdPassSkippedNoCandidate = 0;
    let thirdPassSkippedDueToIcCap = 0;

    if (usePhasedAllocation) {
      pushTrace("build_slots", {
        strategy:
          "Phased: P1→P2→P3→NP; zone rounds follow seq_zone (then defaults / requirement zones). Within each zone, seats expand in seq_business order (then tie-break). Zig-zag within the expanded slot list.",
        initialTotalCapacity,
        zoneIterationOrder: effectiveZoneOrder,
        seqBusinessActive: Boolean(seqBusinessRaw?.length)
      });

      const rem = new Map<number, number>();
      for (const r of requirements) rem.set(r.id, Math.max(0, r.remaining));

      const pass1 = await runPhasedAllocationRound({
        conn,
        mode,
        candidates,
        requirements,
        effectiveZoneOrder,
        seqBusinessRaw,
        rem,
        taken,
        assignments,
        perIcCount,
        maxPerIc,
        hrOptions,
        hrRelaxedSecondPass: false,
        genderRelaxedThirdPass: false
      });
      skippedNoCandidate += pass1.skippedNoCandidate;
      skippedDueToIcCap += pass1.skippedDueToIcCap;

      if (hrRelaxExecuted) {
        secondPassRan = true;
        const hrRelaxOptions: HrPickOptions = { preferSuggestedIc, ignoreRoleSuitability: true, ignoreGender };
        const pass2 = await runPhasedAllocationRound({
          conn,
          mode,
          candidates,
          requirements,
          effectiveZoneOrder,
          seqBusinessRaw,
          rem,
          taken,
          assignments,
          perIcCount,
          maxPerIc,
          hrOptions: hrRelaxOptions,
          hrRelaxedSecondPass: true,
          genderRelaxedThirdPass: false
        });
        skippedNoCandidate += pass2.skippedNoCandidate;
        skippedDueToIcCap += pass2.skippedDueToIcCap;
        secondPassSkippedNoCandidate = pass2.skippedNoCandidate;
        secondPassSkippedDueToIcCap = pass2.skippedDueToIcCap;
        pushTrace("hr_relax_unassigned_second_pass", {
          skippedNoCandidate: pass2.skippedNoCandidate,
          skippedDueToIcCap: pass2.skippedDueToIcCap,
          note: "Same seat order as primary; only candidates still unassigned; HR role_name vs candidate_suitable not enforced."
        });
      }

      if (genderRelaxExecuted) {
        thirdPassRan = true;
        /** Align with post-run unassigned insights: if HR-relax pass 2 ran, pass 3 keeps HR relaxed so “gender-only” blocks match who can actually be picked here. */
        const g3IgnoreHr = ignoreRoleSuitability || secondPassRan;
        const g3Options: HrPickOptions = { preferSuggestedIc, ignoreRoleSuitability: g3IgnoreHr, ignoreGender: true };
        const pass3 = await runPhasedAllocationRound({
          conn,
          mode,
          candidates,
          requirements,
          effectiveZoneOrder,
          seqBusinessRaw,
          rem,
          taken,
          assignments,
          perIcCount,
          maxPerIc,
          hrOptions: g3Options,
          hrRelaxedSecondPass: false,
          genderRelaxedThirdPass: true
        });
        skippedNoCandidate += pass3.skippedNoCandidate;
        skippedDueToIcCap += pass3.skippedDueToIcCap;
        thirdPassSkippedNoCandidate = pass3.skippedNoCandidate;
        thirdPassSkippedDueToIcCap = pass3.skippedDueToIcCap;
        pushTrace("gender_relax_unassigned_third_pass", {
          skippedNoCandidate: pass3.skippedNoCandidate,
          skippedDueToIcCap: pass3.skippedDueToIcCap,
          note: secondPassRan
            ? "Same seat order as prior passes; only still-unassigned; seat-line gender not enforced; HR role rules stay relaxed like pass 2 (consistent with unassigned-vs-open-seats insight)."
            : "Same seat order as prior passes; only still-unassigned; seat-line gender not enforced; HR matches primary run policy."
        });
      }
    } else {
      const sortedLegacyReqs = sortRequirementsForLegacyPass(
        requirements,
        effectiveZoneOrder,
        seqBusinessRaw
      );
      const rem = new Map<number, number>();
      for (const r of requirements) rem.set(r.id, Math.max(0, r.remaining));
      const slotsPass1 = sortedLegacyReqs.reduce((s, r) => s + Math.max(rem.get(r.id) ?? 0, 0), 0);
      let slotsPass2 = 0;
      let slotsPass3 = 0;

      pushTrace("build_slots", {
        slotCount: slotsPass1,
        hrRelaxSecondPassPlanned: hrRelaxExecuted,
        zigZag:
          "Legacy: seats ordered by seq_zone + seq_business (then discipline/profile/gender/icname); single pass — any zone1/2/3 may match; zig-zag over slots; prefer suggested_ic; merit order.",
        initialTotalCapacity,
        zoneSortOrder: effectiveZoneOrder,
        seqBusinessActive: Boolean(seqBusinessRaw?.length)
      });

      const pass1 = await runLegacyAllocationRound({
        conn,
        mode,
        candidates,
        sortedLegacyReqs,
        rem,
        taken,
        assignments,
        perIcCount,
        maxPerIc,
        hrOptions,
        hrRelaxedSecondPass: false,
        genderRelaxedThirdPass: false
      });
      skippedNoCandidate += pass1.skippedNoCandidate;
      skippedDueToIcCap += pass1.skippedDueToIcCap;

      if (hrRelaxExecuted) {
        secondPassRan = true;
        slotsPass2 = sortedLegacyReqs.reduce((s, r) => s + Math.max(rem.get(r.id) ?? 0, 0), 0);
        const hrRelaxOptions: HrPickOptions = { preferSuggestedIc, ignoreRoleSuitability: true, ignoreGender };
        const pass2 = await runLegacyAllocationRound({
          conn,
          mode,
          candidates,
          sortedLegacyReqs,
          rem,
          taken,
          assignments,
          perIcCount,
          maxPerIc,
          hrOptions: hrRelaxOptions,
          hrRelaxedSecondPass: true,
          genderRelaxedThirdPass: false
        });
        skippedNoCandidate += pass2.skippedNoCandidate;
        skippedDueToIcCap += pass2.skippedDueToIcCap;
        secondPassSkippedNoCandidate = pass2.skippedNoCandidate;
        secondPassSkippedDueToIcCap = pass2.skippedDueToIcCap;
        pushTrace("hr_relax_unassigned_second_pass", {
          skippedNoCandidate: pass2.skippedNoCandidate,
          skippedDueToIcCap: pass2.skippedDueToIcCap,
          note: "Same seat order as primary; only candidates still unassigned; HR role_name vs candidate_suitable not enforced."
        });
      }

      if (genderRelaxExecuted) {
        thirdPassRan = true;
        slotsPass3 = sortedLegacyReqs.reduce((s, r) => s + Math.max(rem.get(r.id) ?? 0, 0), 0);
        const g3IgnoreHr = ignoreRoleSuitability || secondPassRan;
        const g3Options: HrPickOptions = { preferSuggestedIc, ignoreRoleSuitability: g3IgnoreHr, ignoreGender: true };
        const pass3 = await runLegacyAllocationRound({
          conn,
          mode,
          candidates,
          sortedLegacyReqs,
          rem,
          taken,
          assignments,
          perIcCount,
          maxPerIc,
          hrOptions: g3Options,
          hrRelaxedSecondPass: false,
          genderRelaxedThirdPass: true
        });
        skippedNoCandidate += pass3.skippedNoCandidate;
        skippedDueToIcCap += pass3.skippedDueToIcCap;
        thirdPassSkippedNoCandidate = pass3.skippedNoCandidate;
        thirdPassSkippedDueToIcCap = pass3.skippedDueToIcCap;
        pushTrace("gender_relax_unassigned_third_pass", {
          skippedNoCandidate: pass3.skippedNoCandidate,
          skippedDueToIcCap: pass3.skippedDueToIcCap,
          note: secondPassRan
            ? "Same seat order as prior passes; only still-unassigned; seat-line gender not enforced; HR relaxed like pass 2 (consistent with insight)."
            : "Same seat order as prior passes; only still-unassigned; seat-line gender not enforced; HR matches primary run policy."
        });
      }

      legacyTotalSlotIterations = slotsPass1 + slotsPass2 + slotsPass3;
      if (hrRelaxExecuted && includeTrace) {
        pushTrace("legacy_slot_counts_after_hr_relax", {
          slotCountPass1: slotsPass1,
          slotCountPass2HrRelax: slotsPass2,
          slotCountTotal: legacyTotalSlotIterations
        });
      }
    }

    const perIcAssignments = Object.fromEntries(
      [...perIcCount.entries()].sort((a, b) => a[0].localeCompare(b[0]))
    );

    pushTrace("allocation_loop_complete", {
      iterationsCapacity: initialTotalCapacity,
      assigned: assignments.length,
      skippedNoCandidate,
      skippedDueToIcCap,
      maxPerIc: maxPerIc ?? null,
      persist: mode === "run" ? "requirements + candidates + logs_business" : "none (simulate)"
    });

    const insightHrOptions: HrPickOptions = {
      preferSuggestedIc,
      ignoreRoleSuitability: ignoreRoleSuitability || secondPassRan,
      ignoreGender
    };
    const placementsFromHrRelaxPass = assignments.filter((a) => a.hrRelaxedSecondPass).length;
    const placementsFromGenderRelaxPass = assignments.filter((a) => a.genderRelaxedThirdPass).length;

    const hrRelaxUnassignedSecondPassSummary = {
      requested: hrRelaxRequested,
      executed: secondPassRan,
      skipReason:
        hrRelaxRequested && ignoreRoleSuitability
          ? ("primary_run_already_ignores_hr" as const)
          : undefined,
      assignmentsAdded: placementsFromHrRelaxPass,
      secondPassSkippedNoCandidate: secondPassRan ? secondPassSkippedNoCandidate : 0,
      secondPassSkippedDueToIcCap: secondPassRan ? secondPassSkippedDueToIcCap : 0
    };

    const genderRelaxUnassignedThirdPassSummary = {
      requested: genderRelaxRequested,
      executed: thirdPassRan,
      skipReason:
        genderRelaxRequested && ignoreGender ? ("primary_run_already_ignores_gender" as const) : undefined,
      assignmentsAdded: placementsFromGenderRelaxPass,
      thirdPassSkippedNoCandidate: thirdPassRan ? thirdPassSkippedNoCandidate : 0,
      thirdPassSkippedDueToIcCap: thirdPassRan ? thirdPassSkippedDueToIcCap : 0
    };

    const unassignedSummary = computeUnassignedSummary(
      candidates,
      assignments,
      requirements,
      insightHrOptions,
      {
        totalSlots: initialTotalCapacity,
        skippedNoCandidate,
        skippedDueToIcCap,
        useLegacyEligibility
      }
    );
    const unassignedDetails = input.includeUnassignedLog
      ? buildUnassignedDetails(
          candidates,
          assignments,
          requirements,
          insightHrOptions,
          useLegacyEligibility,
          500
        )
      : undefined;

    const requirementSeatsStillOpen =
      initialTotalCapacity > 0 ? Math.max(0, initialTotalCapacity - assignments.length) : 0;
    const legacyIterationsMatch =
      legacyTotalSlotIterations !== undefined
        ? assignments.length + skippedNoCandidate + skippedDueToIcCap === legacyTotalSlotIterations
        : undefined;

    const reconciliation = {
      capacityField: simulateFromFresh ? ("newvalue" as const) : ("remaining" as const),
      /** Sum of seat counts on requirement rows used for this run (after filters). */
      totalSeatCapacityLoaded: initialTotalCapacity,
      requirementRowsLoaded: requirements.length,
      /** Successful placements (one seat consumed from some requirement row each time). */
      seatsFilled: assignments.length,
      /** Seats still available on those rows after this run (skips do not consume seats). */
      requirementSeatsStillOpen,
      candidatesInPool: candidates.length,
      slotsSkippedNoEligibleCandidate: skippedNoCandidate,
      slotsSkippedDueToIcCap: skippedDueToIcCap,
      allocationShape: usePhasedAllocation ? ("phased" as const) : ("legacy_single_pass" as const),
      /** Phased: seatsFilled + requirementSeatsStillOpen === totalSeatCapacityLoaded */
      capacityEquationHolds:
        initialTotalCapacity === assignments.length + requirementSeatsStillOpen,
      /** Legacy: every slot iteration ended as assign or skip. */
      legacySlotIterationsTotal: legacyTotalSlotIterations ?? null,
      legacyIterationCountMatches: legacyIterationsMatch ?? null,
      verifyAgainstDbSql:
        "SELECT gender, profile, discipline, zone, business, icname, SUM(newvalue) AS seats, SUM(allocated) AS filled FROM requirements GROUP BY gender, profile, discipline, zone, business, icname;",
      exportHint:
        "Download assignments as CSV from this page, then pivot table: count rows by gender, profile, discipline, zone, business, IC (seat) and match to each requirements row."
    };

    pushTrace("complete", {
      assigned: assignments.length,
      unassigned: candidates.length - assignments.length,
      unassignedSummary,
      hrRelaxUnassignedSecondPass: hrRelaxUnassignedSecondPassSummary,
      genderRelaxUnassignedThirdPass: genderRelaxUnassignedThirdPassSummary
    });

    const icGenderSeatReport = buildIcGenderSeatReport(requirements, assignments);
    const icGenderSeatReportTotals = sumIcGenderSeatReport(icGenderSeatReport);
    const unassignedIcInsights = buildUnassignedIcInsights(
      candidates,
      assignments,
      requirements,
      insightHrOptions,
      useLegacyEligibility
    );

    return {
      mode,
      filters: input,
      candidatesConsidered: candidates.length,
      requirementsConsidered: requirements.length,
      requirementDiagnostics,
      matchDiagnostics,
      fairness: {
        maxPerIc: maxPerIc ?? null,
        perIcAssignments,
        skippedDueToIcCap,
        note:
          maxPerIc !== undefined
            ? "Each icname can receive at most maxPerIc assignments in this run; extra slots are skipped."
            : "No per-IC cap set. Zig-zag spreads requirement rows but a single IC with many seats can still take many top-merit candidates. Set maxPerIc to limit."
      },
      allocationStrategy: usePhasedAllocation
        ? {
            mode: "phased",
            order: `P1→P2→P3→NP; zones iterate as [${effectiveZoneOrder.join(", ")}] (seq_zone when populated, else N/S/E/W + extras). Within each zone, seats follow seq_business row order (then tie-break columns). Eligibility: discipline/profile${
              ignoreGender ? "" : "/gender"
            }/business/HR/zone phase; merit + suggested_ic.`
          }
        : {
            mode: "legacy",
            order: `Single pass over seats ordered by zone [${effectiveZoneOrder.join(", ")}] then seq_business; any zone1/2/3 may match requirement.zone; zig-zag; merit + suggested_ic.`
          },
      sequenceOrder: {
        seqZone: seqZoneRaw,
        seqBusiness: seqBusinessRaw,
        zoneIterationOrder: effectiveZoneOrder
      },
      hrPolicy: {
        preferSuggestedIc,
        ignoreRoleSuitability,
        ignoreGender,
        suitability:
          "If “Ignore Panel HR role suggested” is OFF: candidate_suitable is required (non-empty after trim) for any seat. If requirements.role_name is set on a seat line, candidate_suitable must match it. If “Ignore Panel HR role suggested” is ON, role_name vs candidate_suitable is not enforced.",
        suggestedIc:
          "preferSuggestedIc: among eligible candidates, prefer those whose suggested_ic matches requirement.icname when any exist; otherwise highest merit. Suggested IC = Yes in results only when this flag was true and the chosen candidate matched. When preferSuggestedIc is false, assignments always report Suggested IC = No (merit-only; HR sugg. name column may still show their suggested_ic for reference).",
        secondPassUnassignedHrRelax:
          "When enabled and the primary run keeps HR strict: after all primary passes complete, the engine walks remaining open seats again in the same order, but only among candidates still unassigned, with role_name vs candidate_suitable ignored. Gender, profile, discipline, zone phase rules, and business matching are unchanged (unless ignoreGender is on, which relaxes gender in every pass). Rows from this pass include hrRelaxedSecondPass: true.",
        ignoreGenderPolicy:
          "When ignoreGender is true, candidate gender need not match the requirement row gender for eligibility, picks, and post-run unassigned diagnostics; requirement row still carries seat-line gender in DB/logs.",
        thirdPassUnassignedGenderRelax:
          "When genderRelaxUnassignedThirdPass is on and ignoreGender is off: after primary (and optional HR-relax second pass), remaining open seats are filled in the same order from still-unassigned candidates with seat-line gender not enforced. If the HR-relax second pass ran, pass 3 keeps HR relaxed like pass 2; otherwise HR follows the primary run. Rows include genderRelaxedThirdPass: true."
      },
      hrRelaxUnassignedSecondPass: hrRelaxUnassignedSecondPassSummary,
      genderRelaxUnassignedThirdPass: genderRelaxUnassignedThirdPassSummary,
      assigned: assignments.length,
      unassigned: candidates.length - assignments.length,
      unassignedSummary,
      icGenderSeatReport,
      icGenderSeatReportTotals,
      unassignedIcInsights,
      ...(unassignedDetails ? { unassignedDetails } : {}),
      assignments,
      reconciliation,
      profilesMissingRequirements,
      ...(includeTrace ? { processingTrace: trace } : {})
    };
  });
}
