import type { PoolConnection } from "mysql2/promise";
import type { AllocationInput, AllocationMode, Candidate, RequirementRow } from "../types.js";
import { pickRowString } from "../util/row-fields.js";
import {
  computeProfilesMissingRequirements,
  loadRequirementProfilesCatalog,
  type ProfileWithoutRequirements
} from "./profile-coverage.js";

type Movement = "Side&Down" | "Down" | "Side&Up" | "Up";

/** Row shape from `requirements_zone_calculated` (old Node script). */
export type ZoneCalculatedRow = {
  gender: string;
  profile: string;
  discipline: string;
  zone: string;
  newvalue: number;
  allocated: number;
  remaining: number;
};

function asText(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}

function trim(v: unknown): string {
  return asText(v).trim();
}

/**
 * Stateful zig-zag from the legacy script (Side&Down / Down / Up / Side&Up).
 * Returns row index into `requirements` array (query order = ORDER BY newvalue DESC).
 */
export function scriptMovementPickRow<T extends { newvalue: number; allocated: number }>(
  requirements: T[],
  state: { IC_CurrentRow: number; sMovement: Movement }
): { rowIndex: number; breakCandidateLoop: boolean } {
  const IC_RowsCount = requirements.length;
  let Continue_Cnt = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    let dowhile_continue = false;

    if (state.sMovement === "Side&Down" || state.sMovement === "Side&Up") {
      if (IC_RowsCount > 1) {
        state.sMovement = state.sMovement === "Side&Down" ? "Down" : "Up";
      }
    } else if (state.sMovement === "Down") {
      state.IC_CurrentRow += 1;
      if (state.IC_CurrentRow === IC_RowsCount) state.sMovement = "Side&Up";
    } else if (state.sMovement === "Up") {
      state.IC_CurrentRow -= 1;
      if (state.IC_CurrentRow === 1) state.sMovement = "Side&Down";
    }

    const RowID = state.IC_CurrentRow - 1;
    const Zone_Value = requirements[RowID].newvalue;
    const Zone_Allocated = requirements[RowID].allocated;

    if (Zone_Value <= Zone_Allocated) {
      Continue_Cnt += 1;
      if (Continue_Cnt > IC_RowsCount * 2) {
        return { rowIndex: RowID, breakCandidateLoop: true };
      }
      dowhile_continue = true;
    }

    if (!dowhile_continue) {
      return { rowIndex: RowID, breakCandidateLoop: false };
    }
  }
}

async function loadSeqExecuted(conn: PoolConnection, table: string): Promise<Record<string, unknown>[]> {
  const [rows] = await conn.query(`SELECT * FROM ${table} WHERE execute = 1`);
  return rows as Record<string, unknown>[];
}

async function loadZoneRequirements(
  conn: PoolConnection,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pZone: string,
  simulateFromFresh: boolean
): Promise<ZoneCalculatedRow[]> {
  const capCol = simulateFromFresh ? "newvalue" : "remaining";
  const params: string[] = [pGender, pProfile, pDiscipline];
  let sql = `
    SELECT gender, profile, discipline, zone, newvalue, allocated, remaining
    FROM requirements_zone_calculated
    WHERE TRIM(gender) = TRIM(?) AND TRIM(profile) = TRIM(?) AND TRIM(discipline) = TRIM(?)
      AND ${capCol} > 0
  `;
  const cardinals = ["North", "South", "East", "West"];
  if (cardinals.includes(pZone)) {
    sql += ` AND TRIM(zone) = TRIM(?)`;
    params.push(pZone);
  }
  sql += ` ORDER BY newvalue DESC`;
  const [rows] = await conn.query(sql, params);
  return (rows as Record<string, unknown>[]).map((r) => ({
    gender: trim(r.gender),
    profile: trim(r.profile),
    discipline: trim(r.discipline),
    zone: trim(r.zone),
    newvalue: Number(r.newvalue ?? 0),
    allocated: Number(r.allocated ?? 0),
    remaining: Number(r.remaining ?? 0)
  }));
}

/** Apply optional dashboard filters (normalized) on top of script triple. */
async function loadZoneCandidatesFiltered(
  conn: PoolConnection,
  input: AllocationInput,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pZone: string,
  pPriority: string,
  simulateFromFresh: boolean
): Promise<Candidate[]> {
  const manualClause = "COALESCE(isManual, 0) = 0";
  const params: unknown[] = [pGender, pProfile, pDiscipline];
  const where: string[] = [
    "TRIM(gender) = TRIM(?)",
    "TRIM(profile) = TRIM(?)",
    "TRIM(discipline) = TRIM(?)",
    manualClause
  ];
  if (!simulateFromFresh) where.push("allocated_zone IS NULL");

  if (input.gender) {
    where[0] = "LOWER(TRIM(gender)) = ?";
    params[0] = trim(input.gender).toLowerCase();
  }
  if (input.profile) {
    where[1] = "LOWER(TRIM(profile)) = ?";
    params[1] = trim(input.profile).toLowerCase();
  }
  if (input.discipline) {
    where[2] = "LOWER(TRIM(discipline)) = ?";
    params[2] = trim(input.discipline).toLowerCase();
  }

  let zoneSql = "";
  if (trim(pZone) !== "") {
    params.push(pZone);
    if (pPriority === "P1") zoneSql = " AND TRIM(zone1) = TRIM(?)";
    else if (pPriority === "P2") zoneSql = " AND TRIM(zone2) = TRIM(?)";
    else if (pPriority === "P3") zoneSql = " AND TRIM(zone3) = TRIM(?)";
    else zoneSql = " AND TRIM(zone1) = TRIM(?)";
  }

  const sql = `
    SELECT id, email, discipline, profile, gender,
           zone1, zone2, zone3, business1, business2, business3,
           meritscore, allocated_zone, allocated_business, allocated_ic,
           NULL AS allocated_role,
           suggested_ic, candidate_suitable
    FROM candidates
    WHERE ${where.join(" AND ")}${zoneSql}
    ORDER BY meritscore DESC, id ASC
  `;

  const [rows] = await conn.query(sql, params);
  return rows as Candidate[];
}

type BusinessRequirementWorking = RequirementRow & { newvalue: number };

async function loadBusinessRequirements(
  conn: PoolConnection,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pZone: string,
  pBusiness: string,
  simulateFromFresh: boolean
): Promise<BusinessRequirementWorking[]> {
  const capCol = simulateFromFresh ? "newvalue" : "remaining";
  const [rows] = await conn.query(
    `
    SELECT id, discipline, profile, gender, zone, business, icname, role_name, allocated, newvalue,
           ${capCol} AS remaining
    FROM requirements
    WHERE TRIM(gender) = TRIM(?) AND TRIM(profile) = TRIM(?) AND TRIM(discipline) = TRIM(?)
      AND TRIM(zone) = TRIM(?) AND business = ?
      AND ${capCol} > 0
    ORDER BY newvalue DESC
    `,
    [pGender, pProfile, pDiscipline, pZone, pBusiness]
  );
  return (rows as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id),
    discipline: trim(r.discipline),
    profile: trim(r.profile),
    gender: trim(r.gender),
    zone: trim(r.zone),
    business: trim(r.business),
    icname: pickRowString(r, ["icname", "ic_name", "ICName", "ic"]),
    allocated: Number(r.allocated ?? 0),
    remaining: Number(r.remaining ?? 0),
    newvalue: Number(r.newvalue ?? 0),
    role_name: r.role_name != null ? trim(r.role_name) : null
  }));
}

/**
 * In simulate mode the DB is not updated after the zone phase, so `allocated_zone` would still be NULL.
 * We match business candidates using an in-memory map from the simulated zone pass (same as persisting would).
 */
async function loadBusinessCandidates(
  conn: PoolConnection,
  input: AllocationInput,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pZone: string,
  pBusiness: string,
  pPriority: string,
  simulateFromFresh: boolean,
  mode: AllocationMode,
  simZoneByCandidateId: Map<number, string> | null,
  simBusinessAssignedIds: Set<number> | null
): Promise<Candidate[]> {
  const manualClause = "COALESCE(isManual, 0) = 0";
  let prefClause = "TRIM(business1) = TRIM(?)";
  if (pPriority === "P2") prefClause = "TRIM(business2) = TRIM(?)";
  else if (pPriority === "P3") prefClause = "TRIM(business3) = TRIM(?)";

  const useSimZone = mode === "simulate" && simZoneByCandidateId != null;
  const params: unknown[] = [pGender, pProfile, pDiscipline];
  const where: string[] = [
    "TRIM(gender) = TRIM(?)",
    "TRIM(profile) = TRIM(?)",
    "TRIM(discipline) = TRIM(?)",
    manualClause
  ];
  if (!useSimZone) {
    where.push("allocated_zone = ?");
    params.push(pZone);
  }
  where.push(prefClause);
  params.push(pBusiness);

  if (!simulateFromFresh) where.push("allocated_business IS NULL");

  if (input.gender) {
    where[0] = "LOWER(TRIM(gender)) = ?";
    params[0] = trim(input.gender).toLowerCase();
  }
  if (input.profile) {
    where[1] = "LOWER(TRIM(profile)) = ?";
    params[1] = trim(input.profile).toLowerCase();
  }
  if (input.discipline) {
    where[2] = "LOWER(TRIM(discipline)) = ?";
    params[2] = trim(input.discipline).toLowerCase();
  }

  const sql = `
    SELECT id, email, discipline, profile, gender,
           zone1, zone2, zone3, business1, business2, business3,
           meritscore, allocated_zone, allocated_business, allocated_ic,
           NULL AS allocated_role,
           suggested_ic, candidate_suitable
    FROM candidates
    WHERE ${where.join(" AND ")}
    ORDER BY meritscore DESC, id ASC
  `;

  const [rows] = await conn.query(sql, params);
  let list = rows as Candidate[];
  if (useSimZone) {
    const wantZ = trim(pZone).toLowerCase();
    list = list.filter((c) => {
      if (simBusinessAssignedIds?.has(c.id)) return false;
      return trim(simZoneByCandidateId!.get(c.id) ?? "").toLowerCase() === wantZ;
    });
  }
  return list;
}

type LegacyAssignment = {
  candidateId: number;
  email: string;
  meritscore: number;
  profile: string;
  discipline: string;
  gender: string;
  /** Seat line gender for this slice (zone phase uses loop gender; business phase uses requirement row). */
  requirementGender?: string;
  zone: string;
  business: string;
  icname: string;
  suggestedIcMatch: false;
  suggestedIc: string;
  servicePreferences: string;
  requirementRoleName: null;
  candidateSuitable: string | null;
  roleSuitability: "not_required";
  preferencePhase: "ANY";
  legacyPhase: "ZONE" | "BUSINESS";
};

export type LegacyUnassignedDetail = {
  candidateId: number;
  email: string;
  meritscore: number;
  reasonCode: "NEVER_ELIGIBLE" | "ELIGIBLE_CAPACITY_OR_MERIT";
  detail: string;
  detailBullets: string[];
  candidateSuitable?: string | null;
  suggestedIc?: string | null;
};

export type LegacyUnassignedSummary = {
  totalUnassigned: number;
  neverEligibleForAnyRequirement: number;
  eligibleButNotAssigned: number;
  totalSlotsInRun: number;
  skippedSlotsNoCandidate: number;
  skippedSlotsDueToIcCap: number;
  explanation: string;
};

export type LegacyTwoPhaseResult = {
  mode: AllocationMode;
  legacyTwoPhaseScript: true;
  filters: AllocationInput;
  /** IC placements (business phase); matches unified API “assigned” for KPIs. */
  assigned: number;
  unassigned: number;
  candidatesConsidered: number;
  requirementsConsidered: number;
  allocationStrategy: { mode: string; order: string };
  zoneAssignments: LegacyAssignment[];
  businessAssignments: LegacyAssignment[];
  assignments: LegacyAssignment[];
  candidatesConsideredZonePasses: number;
  candidatesConsideredBusinessPasses: number;
  /** Present when `includeUnassignedLog` was true (same shape as unified engine). */
  unassignedSummary?: LegacyUnassignedSummary;
  unassignedDetails?: LegacyUnassignedDetail[];
  /** Candidate profiles with no matching rows on `requirements` (same filter scope). */
  profilesMissingRequirements?: ProfileWithoutRequirements[];
  processingTrace?: Array<{ step: string; detail?: Record<string, unknown> }>;
};

async function allocateToZonesScript(
  conn: PoolConnection,
  input: AllocationInput,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pPriority: string,
  pZone: string,
  mode: AllocationMode,
  simulateFromFresh: boolean,
  trace: Array<{ step: string; detail?: Record<string, unknown> }> | undefined,
  includeTrace: boolean,
  simZoneByCandidateId: Map<number, string> | null
): Promise<LegacyAssignment[]> {
  const out: LegacyAssignment[] = [];
  const requirements = await loadZoneRequirements(conn, pGender, pProfile, pDiscipline, pZone, simulateFromFresh);
  if (!requirements.length) return out;

  const working = requirements.map((r) => ({ ...r }));
  let candidates = await loadZoneCandidatesFiltered(
    conn,
    input,
    pGender,
    pProfile,
    pDiscipline,
    pZone,
    pPriority,
    simulateFromFresh
  );
  if (mode === "simulate" && simZoneByCandidateId) {
    candidates = candidates.filter((c) => !simZoneByCandidateId.has(c.id));
  }
  if (!candidates.length) return out;

  const state = { IC_CurrentRow: 1, sMovement: "Side&Down" as Movement };

  for (const candidate of candidates) {
    const pick = scriptMovementPickRow(working, state);
    if (pick.breakCandidateLoop) break;

    const row = working[pick.rowIndex];
    const Zone_Name = row.zone;
    row.allocated += 1;

    if (mode === "run") {
      await conn.query(
        `UPDATE requirements_zone_calculated SET allocated = ?
         WHERE TRIM(gender) = TRIM(?) AND TRIM(profile) = TRIM(?) AND TRIM(discipline) = TRIM(?) AND TRIM(zone) = TRIM(?)`,
        [row.allocated, pGender, pProfile, pDiscipline, Zone_Name]
      );
      await conn.query(`UPDATE candidates SET allocated_zone = ? WHERE id = ?`, [Zone_Name, candidate.id]);
    } else if (simZoneByCandidateId) {
      simZoneByCandidateId.set(candidate.id, Zone_Name);
    }

    const svc = [candidate.business1, candidate.business2, candidate.business3]
      .map((v) => asText(v).trim())
      .filter(Boolean)
      .join(" · ");

    out.push({
      candidateId: candidate.id,
      email: candidate.email,
      meritscore: candidate.meritscore,
      profile: asText(candidate.profile),
      discipline: asText(candidate.discipline),
      gender: asText(candidate.gender),
      requirementGender: pGender,
      zone: Zone_Name,
      business: "",
      icname: "(zone only)",
      suggestedIcMatch: false,
      suggestedIc: asText(candidate.suggested_ic ?? ""),
      servicePreferences: svc,
      requirementRoleName: null,
      candidateSuitable: trim(candidate.candidate_suitable ?? "") ? trim(candidate.candidate_suitable) : null,
      roleSuitability: "not_required",
      preferencePhase: "ANY",
      legacyPhase: "ZONE"
    });

    if (includeTrace && trace) {
      trace.push({
        step: "legacy_zone_allocated",
        detail: { email: candidate.email, zone: Zone_Name, gender: pGender, profile: pProfile, discipline: pDiscipline }
      });
    }
  }

  return out;
}

async function allocateToBusinessScript(
  conn: PoolConnection,
  input: AllocationInput,
  pGender: string,
  pProfile: string,
  pDiscipline: string,
  pZone: string,
  pPriority: string,
  pBusiness: string,
  mode: AllocationMode,
  simulateFromFresh: boolean,
  trace: Array<{ step: string; detail?: Record<string, unknown> }> | undefined,
  includeTrace: boolean,
  simZoneByCandidateId: Map<number, string> | null,
  simBusinessAssignedIds: Set<number> | null
): Promise<LegacyAssignment[]> {
  const out: LegacyAssignment[] = [];
  const requirements = await loadBusinessRequirements(
    conn,
    pGender,
    pProfile,
    pDiscipline,
    pZone,
    pBusiness,
    simulateFromFresh
  );
  if (!requirements.length) return out;

  const working = requirements.map((r) => ({ ...r }));
  const candidates = await loadBusinessCandidates(
    conn,
    input,
    pGender,
    pProfile,
    pDiscipline,
    pZone,
    pBusiness,
    pPriority,
    simulateFromFresh,
    mode,
    simZoneByCandidateId,
    simBusinessAssignedIds
  );
  if (!candidates.length) return out;

  const state = { IC_CurrentRow: 1, sMovement: "Side&Down" as Movement };

  for (const candidate of candidates) {
    const pick = scriptMovementPickRow(working, state);
    if (pick.breakCandidateLoop) break;

    const req = working[pick.rowIndex];
    req.allocated += 1;

    if (mode === "run") {
      await conn.query(`UPDATE requirements SET allocated = ? WHERE id = ?`, [req.allocated, req.id]);
      await conn.query(
        `UPDATE candidates SET allocated_business = ?, allocated_ic = ? WHERE id = ?`,
        [pBusiness, req.icname, candidate.id]
      );
      await conn.query(
        `
        INSERT INTO logs_business
        (gender, profile, discipline, zone, business_priority, business, icname, email, meritscore)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          req.gender,
          req.profile,
          req.discipline,
          pZone,
          pPriority,
          pBusiness,
          req.icname,
          candidate.email,
          candidate.meritscore
        ]
      );
    } else if (simBusinessAssignedIds) {
      simBusinessAssignedIds.add(candidate.id);
    }

    const svc = [candidate.business1, candidate.business2, candidate.business3]
      .map((v) => asText(v).trim())
      .filter(Boolean)
      .join(" · ");

    out.push({
      candidateId: candidate.id,
      email: candidate.email,
      meritscore: candidate.meritscore,
      profile: asText(candidate.profile),
      discipline: asText(candidate.discipline),
      gender: asText(candidate.gender),
      requirementGender: asText(req.gender),
      zone: pZone,
      business: pBusiness,
      icname: asText(req.icname ?? ""),
      suggestedIcMatch: false,
      suggestedIc: asText(candidate.suggested_ic ?? ""),
      servicePreferences: svc,
      requirementRoleName: null,
      candidateSuitable: trim(candidate.candidate_suitable ?? "") ? trim(candidate.candidate_suitable) : null,
      roleSuitability: "not_required",
      preferencePhase: "ANY",
      legacyPhase: "BUSINESS"
    });

    if (includeTrace && trace) {
      trace.push({
        step: "legacy_business_allocated",
        detail: {
          email: candidate.email,
          zone: pZone,
          business: pBusiness,
          icname: req.icname
        }
      });
    }
  }

  return out;
}

async function countCandidatesPool(
  conn: PoolConnection,
  input: AllocationInput,
  simulateFromFresh: boolean
): Promise<number> {
  const where: string[] = ["COALESCE(isManual, 0) = 0"];
  const params: unknown[] = [];
  if (!simulateFromFresh) {
    where.push("allocated_business IS NULL");
    where.push("allocated_ic IS NULL");
  }
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(trim(input.gender).toLowerCase());
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(trim(input.profile).toLowerCase());
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(trim(input.discipline).toLowerCase());
  }
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS c FROM candidates WHERE ${where.join(" AND ")}`,
    params
  );
  return Number((row as { c: number }).c ?? 0);
}

async function countRequirementsPool(
  conn: PoolConnection,
  input: AllocationInput,
  simulateFromFresh: boolean
): Promise<number> {
  const capCol = simulateFromFresh ? "newvalue" : "remaining";
  const where: string[] = [`${capCol} > 0`];
  const params: string[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(trim(input.gender).toLowerCase());
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(trim(input.profile).toLowerCase());
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(trim(input.discipline).toLowerCase());
  }
  const [[row]] = await conn.query(
    `SELECT COUNT(*) AS c FROM requirements WHERE ${where.join(" AND ")}`,
    params
  );
  return Number((row as { c: number }).c ?? 0);
}

async function loadCandidatesPoolRows(
  conn: PoolConnection,
  input: AllocationInput,
  simulateFromFresh: boolean
): Promise<Candidate[]> {
  const where: string[] = ["COALESCE(isManual, 0) = 0"];
  const params: unknown[] = [];
  if (!simulateFromFresh) {
    where.push("allocated_business IS NULL");
    where.push("allocated_ic IS NULL");
  }
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(trim(input.gender).toLowerCase());
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(trim(input.profile).toLowerCase());
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(trim(input.discipline).toLowerCase());
  }
  const [rows] = await conn.query(
    `
    SELECT id, email, discipline, profile, gender,
           zone1, zone2, zone3, business1, business2, business3,
           meritscore, allocated_zone, allocated_business, allocated_ic,
           NULL AS allocated_role, suggested_ic, candidate_suitable
    FROM candidates
    WHERE ${where.join(" AND ")}
    ORDER BY meritscore DESC, id ASC
    `,
    params
  );
  return rows as Candidate[];
}

/** After a legacy run, candidates still without business/IC (DB reflects zone phase). */
async function loadCandidatesStillWithoutIc(conn: PoolConnection, input: AllocationInput): Promise<Candidate[]> {
  const where: string[] = [
    "COALESCE(isManual, 0) = 0",
    "allocated_business IS NULL",
    "allocated_ic IS NULL"
  ];
  const params: unknown[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(trim(input.gender).toLowerCase());
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(trim(input.profile).toLowerCase());
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(trim(input.discipline).toLowerCase());
  }
  const [rows] = await conn.query(
    `
    SELECT id, email, discipline, profile, gender,
           zone1, zone2, zone3, business1, business2, business3,
           meritscore, allocated_zone, allocated_business, allocated_ic,
           NULL AS allocated_role, suggested_ic, candidate_suitable
    FROM candidates
    WHERE ${where.join(" AND ")}
    ORDER BY meritscore DESC, id ASC
    `,
    params
  );
  return rows as Candidate[];
}

async function sumRequirementsCapacity(
  conn: PoolConnection,
  input: AllocationInput,
  simulateFromFresh: boolean
): Promise<number> {
  const capCol = simulateFromFresh ? "newvalue" : "remaining";
  const where: string[] = [`${capCol} > 0`];
  const params: string[] = [];
  if (input.gender) {
    where.push("LOWER(TRIM(gender)) = ?");
    params.push(trim(input.gender).toLowerCase());
  }
  if (input.profile) {
    where.push("LOWER(TRIM(profile)) = ?");
    params.push(trim(input.profile).toLowerCase());
  }
  if (input.discipline) {
    where.push("LOWER(TRIM(discipline)) = ?");
    params.push(trim(input.discipline).toLowerCase());
  }
  const [[row]] = await conn.query(
    `SELECT COALESCE(SUM(${capCol}), 0) AS s FROM requirements WHERE ${where.join(" AND ")}`,
    params
  );
  return Number((row as { s: number }).s ?? 0);
}

function buildLegacyUnassignedReport(
  unassignedList: Candidate[],
  mode: AllocationMode,
  simZoneByCandidateId: Map<number, string> | null,
  totalSlotsInRun: number,
  capacitySourceLabel: string
): { summary: LegacyUnassignedSummary; details: LegacyUnassignedDetail[] } {
  let noZone = 0;
  let hadZoneNoIc = 0;
  const details: LegacyUnassignedDetail[] = [];
  const limit = 500;

  for (const c of unassignedList) {
    const hasZone =
      mode === "simulate"
        ? Boolean(simZoneByCandidateId?.has(c.id))
        : Boolean(trim(c.allocated_zone ?? ""));
    if (!hasZone) {
      noZone += 1;
      if (details.length < limit) {
        details.push({
          candidateId: c.id,
          email: c.email,
          meritscore: c.meritscore,
          reasonCode: "NEVER_ELIGIBLE",
          detail: "No zone assigned in the legacy zone pass for this run.",
          detailBullets: [
            "Zone phase uses requirements_zone_calculated and seq_zone (execute=1).",
            "Candidate must match gender / profile / discipline and zone1/2/3 vs seq priority (P1/P2/P3) for that zone step.",
            "If no capacity or no matching row in requirements_zone_calculated, the candidate gets no zone."
          ],
          candidateSuitable: trim(c.candidate_suitable ?? "") ? trim(c.candidate_suitable) : null,
          suggestedIc: trim(c.suggested_ic ?? "") ? trim(c.suggested_ic) : null
        });
      }
    } else {
      hadZoneNoIc += 1;
      if (details.length < limit) {
        details.push({
          candidateId: c.id,
          email: c.email,
          meritscore: c.meritscore,
          reasonCode: "ELIGIBLE_CAPACITY_OR_MERIT",
          detail: "Zone assigned, but no IC/business seat in the business pass.",
          detailBullets: [
            "Business phase needs a matching row on requirements (gender, profile, discipline, zone, business) with open capacity.",
            "Candidate business1/2/3 must match seq priority (P1/P2/P3) for that business line.",
            "Higher merit candidates may have taken the available seats first."
          ],
          candidateSuitable: trim(c.candidate_suitable ?? "") ? trim(c.candidate_suitable) : null,
          suggestedIc: trim(c.suggested_ic ?? "") ? trim(c.suggested_ic) : null
        });
      }
    }
  }

  const lines = [
    `Total unassigned: ${unassignedList.length}.`,
    noZone > 0
      ? `${noZone}: no zone assignment in the legacy zone phase (check zone capacity, seq_zone, and candidate zone preferences).`
      : null,
    hadZoneNoIc > 0
      ? `${hadZoneNoIc}: zone assigned but no business/IC placement (check requirements rows, seq_business, and business preferences).`
      : null,
    unassignedList.length > 0 && totalSlotsInRun > 0
      ? `Approx. total business requirement capacity (${capacitySourceLabel} sum): ${totalSlotsInRun}.`
      : null
  ].filter(Boolean);

  const summary: LegacyUnassignedSummary = {
    totalUnassigned: unassignedList.length,
    neverEligibleForAnyRequirement: noZone,
    eligibleButNotAssigned: hadZoneNoIc,
    totalSlotsInRun: totalSlotsInRun,
    skippedSlotsNoCandidate: 0,
    skippedSlotsDueToIcCap: 0,
    explanation: lines.join(" ")
  };

  return { summary, details };
}

/**
 * Mirrors the old Node script: nested `seq_*` loops (execute=1), zone phase on
 * `requirements_zone_calculated`, then business phase on `requirements`, with the script’s
 * movement state machine over requirement rows.
 */
export async function executeLegacyTwoPhaseScript(
  conn: PoolConnection,
  mode: AllocationMode,
  input: AllocationInput,
  options: { simulateFromFresh: boolean; includeTrace: boolean; includeUnassignedLog: boolean }
): Promise<LegacyTwoPhaseResult> {
  const { simulateFromFresh, includeTrace, includeUnassignedLog } = options;
  const trace: Array<{ step: string; detail?: Record<string, unknown> }> = [];

  if (includeTrace) {
    trace.push({
      step: "legacy_two_phase_start",
      detail: { mode, simulateFromFresh }
    });
  }
  if (input.ignoreGender && includeTrace) {
    trace.push({
      step: "legacy_ignore_gender_unsupported",
      detail: {
        note: "ignoreGender is ignored in legacy two-phase mode; allocation still follows seq_gender × profile/discipline slices."
      }
    });
  }

  try {
    await conn.query(`SELECT 1 FROM requirements_zone_calculated LIMIT 1`);
  } catch {
    throw new Error(
      "Legacy two-phase script requires table `requirements_zone_calculated` (same as the old Node allocator)."
    );
  }

  const seqGender = await loadSeqExecuted(conn, "seq_gender");
  const seqPd = await loadSeqExecuted(conn, "seq_profile_discipline");
  seqPd.sort((a, b) => trim(a.profile).localeCompare(trim(b.profile)) || trim(a.discipline).localeCompare(trim(b.discipline)));
  const seqZone = await loadSeqExecuted(conn, "seq_zone");
  const seqBusiness = await loadSeqExecuted(conn, "seq_business");

  const simZoneByCandidateId = mode === "simulate" ? new Map<number, string>() : null;
  const simBusinessAssignedIds = mode === "simulate" ? new Set<number>() : null;

  const [candidatesConsidered, requirementsConsidered] = await Promise.all([
    countCandidatesPool(conn, input, simulateFromFresh),
    countRequirementsPool(conn, input, simulateFromFresh)
  ]);

  const zoneAssignments: LegacyAssignment[] = [];
  let zoneCandPasses = 0;

  for (const g of seqGender) {
    const gender = trim(g.gender);
    if (!gender) continue;
    if (input.gender && trim(input.gender).toLowerCase() !== gender.toLowerCase()) continue;

    for (const pd of seqPd) {
      const profile = trim(pd.profile);
      const discipline = trim(pd.discipline);
      if (!profile || !discipline) continue;
      if (input.profile && trim(input.profile).toLowerCase() !== profile.toLowerCase()) continue;
      if (input.discipline && trim(input.discipline).toLowerCase() !== discipline.toLowerCase()) continue;

      for (const z of seqZone) {
        const zone = trim(z.zone);
        const priority = trim(z.priority) || "P1";
        zoneCandPasses += 1;
        const part = await allocateToZonesScript(
          conn,
          input,
          gender,
          profile,
          discipline,
          priority,
          zone,
          mode,
          simulateFromFresh,
          trace,
          includeTrace,
          simZoneByCandidateId
        );
        zoneAssignments.push(...part);
      }
    }
  }

  const businessAssignments: LegacyAssignment[] = [];
  let bizCandPasses = 0;

  for (const g of seqGender) {
    const gender = trim(g.gender);
    if (!gender) continue;
    if (input.gender && trim(input.gender).toLowerCase() !== gender.toLowerCase()) continue;

    for (const pd of seqPd) {
      const profile = trim(pd.profile);
      const discipline = trim(pd.discipline);
      if (!profile || !discipline) continue;
      if (input.profile && trim(input.profile).toLowerCase() !== profile.toLowerCase()) continue;
      if (input.discipline && trim(input.discipline).toLowerCase() !== discipline.toLowerCase()) continue;

      for (const b of seqBusiness) {
        const zone = trim(b.zone);
        const business = trim(b.business);
        const priority = trim(b.priority) || "P1";
        if (!business) continue;
        bizCandPasses += 1;
        const part = await allocateToBusinessScript(
          conn,
          input,
          gender,
          profile,
          discipline,
          zone,
          priority,
          business,
          mode,
          simulateFromFresh,
          trace,
          includeTrace,
          simZoneByCandidateId,
          simBusinessAssignedIds
        );
        businessAssignments.push(...part);
      }
    }
  }

  const assignments = [...zoneAssignments, ...businessAssignments];

  const assignedIcSlots = businessAssignments.length;
  const icIds = new Set(businessAssignments.map((a) => a.candidateId));
  const distinctIcPlacements = icIds.size;
  let unassigned = Math.max(0, candidatesConsidered - distinctIcPlacements);

  let unassignedSummary: LegacyUnassignedSummary | undefined;
  let unassignedDetails: LegacyUnassignedDetail[] | undefined;

  if (includeUnassignedLog) {
    let unassignedList: Candidate[];
    if (mode === "run") {
      unassignedList = await loadCandidatesStillWithoutIc(conn, input);
    } else {
      const pool = await loadCandidatesPoolRows(conn, input, simulateFromFresh);
      unassignedList = pool.filter((c) => !icIds.has(c.id));
    }
    unassigned = unassignedList.length;
    const totalSlots = await sumRequirementsCapacity(conn, input, simulateFromFresh);
    const capLabel = simulateFromFresh ? "newvalue" : "remaining";
    const report = buildLegacyUnassignedReport(
      unassignedList,
      mode,
      simZoneByCandidateId,
      totalSlots,
      capLabel
    );
    unassignedSummary = report.summary;
    unassignedDetails = report.details;
  }

  if (includeTrace) {
    trace.push({
      step: "legacy_two_phase_complete",
      detail: {
        zoneAssignments: zoneAssignments.length,
        businessAssignments: businessAssignments.length,
        candidatesConsidered,
        requirementsConsidered,
        assignedIcSlots,
        unassigned
      }
    });
  }

  const coveragePool = await loadCandidatesPoolRows(conn, input, simulateFromFresh);
  const requirementProfilesCatalog = await loadRequirementProfilesCatalog(conn, input);
  const profilesMissingRequirements = computeProfilesMissingRequirements(
    coveragePool,
    requirementProfilesCatalog
  );

  return {
    mode,
    legacyTwoPhaseScript: true,
    filters: input,
    assigned: assignedIcSlots,
    unassigned,
    candidatesConsidered,
    requirementsConsidered,
    allocationStrategy: {
      mode: "legacy_two_phase",
      order:
        "seq_* (execute=1): zone pass on requirements_zone_calculated, then business pass on requirements; simulate uses in-memory zone map between phases."
    },
    zoneAssignments,
    businessAssignments,
    assignments,
    candidatesConsideredZonePasses: zoneCandPasses,
    candidatesConsideredBusinessPasses: bizCandPasses,
    ...(unassignedSummary ? { unassignedSummary } : {}),
    ...(unassignedDetails?.length ? { unassignedDetails } : {}),
    profilesMissingRequirements,
    ...(includeTrace ? { processingTrace: trace } : {})
  };
}
