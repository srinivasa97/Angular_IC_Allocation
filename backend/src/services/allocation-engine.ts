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
      includeUnassignedLog: z.boolean().optional(),
      phasedPreference: z.boolean().optional(),
      useLegacyTwoPhaseScript: z.boolean().optional()
    })
    .optional()
});

type PreferencePhase = "P1" | "P2" | "P3" | "NP";

const PREFERENCE_PHASES: PreferencePhase[] = ["P1", "P2", "P3", "NP"];
const ZONE_ROUND_ORDER = ["north", "south", "east", "west"] as const;

type Assignment = {
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
  roleSuitability: "not_required" | "matched" | "hr_blank_allowed";
  /** P1=zone1 only, P2=zone2, P3=zone3, NP=anywhere/flexible (legacy OR). Legacy mode uses "ANY". */
  preferencePhase: PreferencePhase | "ANY";
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

function baseRequirementMatch(candidate: Candidate, req: RequirementRow, ignoreRoleSuitability: boolean): boolean {
  if (normalize(candidate.profile) !== normalize(req.profile)) return false;
  if (normalize(candidate.discipline) !== normalize(req.discipline)) return false;
  if (normalize(candidate.gender) !== normalize(req.gender)) return false;
  if (!legacyAllocatedRoleMatches(candidate, req)) return false;
  return hrRoleSuitabilityMatches(candidate, req, ignoreRoleSuitability);
}

function requirementEligibleForPhase(
  candidate: Candidate,
  req: RequirementRow,
  options: { ignoreRoleSuitability: boolean },
  phase: PreferencePhase
): boolean {
  if (!baseRequirementMatch(candidate, req, options.ignoreRoleSuitability)) return false;
  if (!businessMatchesCandidate(candidate, req.business)) return false;
  return zoneMatchesPreferencePhase(candidate, req.zone, phase);
}

function candidatePotentiallyEligiblePhased(
  candidate: Candidate,
  requirements: RequirementRow[],
  options: { ignoreRoleSuitability: boolean }
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
 * - No role_name on requirement → no constraint.
 * - role_name set + candidate_suitable empty → allowed (fill remainder without HR tag).
 * - Both set → must match (normalized).
 */
function hrRoleSuitabilityMatches(candidate: Candidate, req: RequirementRow, ignoreRoleSuitability: boolean): boolean {
  if (ignoreRoleSuitability) return true;
  const rn = normalize(req.role_name ?? "");
  if (!rn) return true;
  const suit = normalize(candidate.candidate_suitable ?? "");
  if (!suit) return true;
  return suit === rn;
}

function classifyRoleSuitability(
  candidate: Candidate,
  req: RequirementRow,
  ignoreRoleSuitability: boolean
): "not_required" | "matched" | "hr_blank_allowed" {
  if (ignoreRoleSuitability) return "not_required";
  const rn = normalize(req.role_name ?? "");
  if (!rn) return "not_required";
  const suit = normalize(candidate.candidate_suitable ?? "");
  if (!suit) return "hr_blank_allowed";
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
  const [rows] = await conn.query(
    `
      SELECT id, email, discipline, profile, gender,
             zone1, zone2, zone3, business1, business2, business3,
             meritscore, allocated_zone, allocated_business, allocated_ic,
             NULL AS allocated_role,
             suggested_ic, candidate_suitable
      FROM candidates
      WHERE ${where.length ? where.join(" AND ") : "1=1"}
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
  options: { ignoreRoleSuitability: boolean }
): boolean {
  if (!baseRequirementMatch(candidate, req, options.ignoreRoleSuitability)) return false;
  if (!zoneMatchesAnyPreference(candidate, req.zone)) return false;
  return businessMatchesCandidate(candidate, req.business);
}

function computeMatchDiagnostics(
  candidates: Candidate[],
  requirements: RequirementRow[],
  options: { ignoreRoleSuitability: boolean },
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

type UnassignedReasonCode = "NEVER_ELIGIBLE" | "ELIGIBLE_CAPACITY_OR_MERIT";

function isCandidateEligibleForRun(
  c: Candidate,
  requirements: RequirementRow[],
  hrOptions: { ignoreRoleSuitability: boolean },
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
  hrOptions: { ignoreRoleSuitability: boolean },
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
      ? `${neverEligible}: no requirement row matched (discipline/profile/gender/business/HR role + ${
          opts.useLegacyEligibility ? "any zone preference" : "P1/P2/P3/NP zone rules"
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
  "If requirement.role_name is set and candidate.candidate_suitable is set, they must match (unless “ignore HR role” is on)."
];

const UNASSIGNED_LEGACY_NEVER_BULLETS = [
  "Gender, profile, and discipline must match a requirement row.",
  "At least one of zone1 / zone2 / zone3 must match requirement.zone (including N/S/E/W).",
  "At least one of business1 / business2 / business3 must match requirement.business.",
  "HR role: if requirement.role_name and candidate.candidate_suitable are both set, they must match (unless ignored)."
];

const UNASSIGNED_ELIGIBLE_BULLETS = [
  "This candidate could sit in at least one open seat under the rules, but did not receive one in this run.",
  "Usually: fewer seats than eligible people, so higher merit (and optional suggested-IC preference) wins.",
  "Some slots may have been skipped (no eligible pick at that step, or max-per-IC cap)."
];

function buildUnassignedDetails(
  candidates: Candidate[],
  assignments: Assignment[],
  requirements: RequirementRow[],
  hrOptions: { ignoreRoleSuitability: boolean },
  useLegacyEligibility: boolean,
  limit: number
): Array<{
  candidateId: number;
  email: string;
  meritscore: number;
  reasonCode: UnassignedReasonCode;
  detail: string;
  detailBullets: string[];
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
        detailBullets: useLegacyEligibility ? [...UNASSIGNED_LEGACY_NEVER_BULLETS] : [...UNASSIGNED_PHASED_NEVER_BULLETS]
      });
    } else {
      out.push({
        candidateId: c.id,
        email: c.email,
        meritscore: c.meritscore,
        reasonCode: "ELIGIBLE_CAPACITY_OR_MERIT",
        detail: "Eligible for at least one seat but not assigned in this run.",
        detailBullets: [...UNASSIGNED_ELIGIBLE_BULLETS]
      });
    }
  }

  return out;
}

function pickCandidateForReq(
  candidates: Candidate[],
  req: RequirementRow,
  taken: Set<number>,
  options: { preferSuggestedIc: boolean; ignoreRoleSuitability: boolean },
  phase?: PreferencePhase
): { candidate: Candidate; suggestedIcMatch: boolean } | null {
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
    return {
      candidate: chosen,
      suggestedIcMatch: Boolean(normalize(chosen.suggested_ic ?? "")) && suggestedIcMatchesRequirement(chosen, req)
    };
  }
  const chosen = eligible[0];
  return {
    candidate: chosen,
    /** When preference is off, merit-only pick — do not show Yes (avoids implying HR suggested-IC was applied). */
    suggestedIcMatch: false
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
    const usePhasedAllocation = input.phasedPreference !== false;
    const useLegacyEligibility = !usePhasedAllocation;
    const hrOptions = { preferSuggestedIc, ignoreRoleSuitability };
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
    const matchDiagnostics = computeMatchDiagnostics(candidates, requirements, { ignoreRoleSuitability }, useLegacyEligibility);
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

      for (const phase of PREFERENCE_PHASES) {
        for (const zoneKey of effectiveZoneOrder) {
          let rowsForZone = requirements.filter(
            (r) => canonicalCardinalZone(r.zone) === zoneKey && (rem.get(r.id) ?? 0) > 0
          );
          if (!rowsForZone.length) continue;
          rowsForZone = sortRequirementsBySeqBusiness(rowsForZone, seqBusinessRaw);

          const slots = rowsForZone.flatMap((r) =>
            Array.from({ length: rem.get(r.id) ?? 0 }, () => r)
          );
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
            const { candidate, suggestedIcMatch } = picked;
            taken.add(candidate.id);
            perIcCount.set(key, (perIcCount.get(key) ?? 0) + 1);
            rem.set(req.id, Math.max(0, (rem.get(req.id) ?? 0) - 1));
            const roleSuitability = classifyRoleSuitability(candidate, req, ignoreRoleSuitability);
            assignments.push({
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
              preferencePhase: phase
            });
            if (mode === "run") {
              await persistAssignment(conn, req, candidate, phase);
            }
          }
        }
      }
    } else {
      const sortedLegacyReqs = sortRequirementsForLegacyPass(
        requirements,
        effectiveZoneOrder,
        seqBusinessRaw
      );
      const requirementSlots = sortedLegacyReqs.flatMap((r) =>
        Array.from({ length: Math.max(r.remaining, 0) }, () => r)
      );
      legacyTotalSlotIterations = requirementSlots.length;
      pushTrace("build_slots", {
        slotCount: requirementSlots.length,
        zigZag:
          "Legacy: seats ordered by seq_zone + seq_business (then discipline/profile/gender/icname); single pass — any zone1/2/3 may match; zig-zag over slots; prefer suggested_ic; merit order.",
        initialTotalCapacity,
        zoneSortOrder: effectiveZoneOrder,
        seqBusinessActive: Boolean(seqBusinessRaw?.length)
      });

      for (let i = 0; i < requirementSlots.length; i += 1) {
        const req = requirementSlots[zigZagIndex(i, requirementSlots.length)];
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
        const { candidate, suggestedIcMatch } = picked;
        taken.add(candidate.id);
        perIcCount.set(key, (perIcCount.get(key) ?? 0) + 1);
        const roleSuitability = classifyRoleSuitability(candidate, req, ignoreRoleSuitability);
        assignments.push({
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
          preferencePhase: "ANY"
        });
        if (mode === "run") {
          await persistAssignment(conn, req, candidate, "AUTO");
        }
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

    const unassignedSummary = computeUnassignedSummary(candidates, assignments, requirements, hrOptions, {
      totalSlots: initialTotalCapacity,
      skippedNoCandidate,
      skippedDueToIcCap,
      useLegacyEligibility
    });
    const unassignedDetails = input.includeUnassignedLog
      ? buildUnassignedDetails(candidates, assignments, requirements, hrOptions, useLegacyEligibility, 500)
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
      unassignedSummary
    });

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
            order: `P1→P2→P3→NP; zones iterate as [${effectiveZoneOrder.join(", ")}] (seq_zone when populated, else N/S/E/W + extras). Within each zone, seats follow seq_business row order (then tie-break columns). Eligibility: discipline/profile/gender/business/HR/zone phase; merit + suggested_ic.`
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
        suitability:
          "If requirements.role_name is empty, no HR role filter. If role_name is set and candidate_suitable is empty, candidate may still be assigned (merit+zone+business). If both are set, they must match.",
        suggestedIc:
          "preferSuggestedIc: among eligible candidates, prefer those whose suggested_ic matches requirement.icname when any exist; otherwise highest merit. Suggested IC = Yes in results only when this flag was true and the chosen candidate matched. When preferSuggestedIc is false, assignments always report Suggested IC = No (merit-only; HR sugg. name column may still show their suggested_ic for reference)."
      },
      assigned: assignments.length,
      unassigned: candidates.length - assignments.length,
      unassignedSummary,
      ...(unassignedDetails ? { unassignedDetails } : {}),
      assignments,
      reconciliation,
      profilesMissingRequirements,
      ...(includeTrace ? { processingTrace: trace } : {})
    };
  });
}
