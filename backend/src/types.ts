export type Candidate = {
  id: number;
  email: string;
  discipline: string;
  profile: string;
  gender: string;
  zone1: string;
  zone2: string;
  zone3: string;
  business1: string;
  business2: string;
  business3: string;
  meritscore: number;
  allocated_zone: string | null;
  allocated_business: string | null;
  allocated_ic: string | null;
  allocated_role?: string | null;
  /** HR-suggested IC name (soft preference vs requirement.icname). */
  suggested_ic?: string | null;
  /** HR role suitability; matched against requirements.role_name when both set. */
  candidate_suitable?: string | null;
  permanent_zone?: string | null;
  permanent_state?: string | null;
};

export type RequirementRow = {
  id: number;
  discipline: string;
  profile: string;
  gender: string;
  zone: string;
  business: string;
  icname: string;
  allocated: number;
  remaining: number;
  /** When set, candidate.candidate_suitable must match (if HR left blank, row is still eligible). */
  role_name?: string | null;
};

export type AllocationMode = "simulate" | "run";

export type AllocationInput = {
  gender?: string;
  profile?: string;
  discipline?: string;
  resetBeforeRun?: boolean;
  includeTrace?: boolean;
  /** Max assignments to the same IC (`icname`) in this run; omit for no limit. */
  maxPerIc?: number;
  /** Prefer candidates whose suggested_ic matches requirement.icname when possible (default true). */
  preferSuggestedIc?: boolean;
  /**
   * If true, ignore requirements.role_name vs candidate_suitable (merit+zone+business only).
   * If false (default strict Panel HR): candidate_suitable must be non-empty; when role_name is set on a seat, it must match.
   */
  ignoreRoleSuitability?: boolean;
  /**
   * When true, candidate gender does not need to match requirement row gender for eligibility or picks.
   * Seat lines still carry their configured gender in data and logs; use for operational runs when gender lines are soft.
   */
  ignoreGender?: boolean;
  /**
   * After the main allocation (strict HR when ignoreRoleSuitability is false), run a second pass over **remaining open seats**
   * using **only still-unassigned candidates**, with HR role suitability ignored. Gender, profile, discipline, zone, and
   * business rules stay the same as the primary run (unless ignoreGender is on, which relaxes gender in both passes).
   */
  hrRelaxUnassignedSecondPass?: boolean;
  /**
   * After primary pass (and optional HR-relax second pass), walk remaining open seats again in the same order using
   * only still-unassigned candidates, with seat-line gender not enforced. HR: same as primary unless pass 2 ran — then
   * HR stays relaxed like pass 2 (aligned with unassigned-vs-open-seats insight after an HR-relax run).
   * No effect when ignoreGender is true (primary already ignores gender) or with legacy two-phase script.
   */
  genderRelaxUnassignedThirdPass?: boolean;
  /** When true, response includes `unassignedDetails` (capped) with per-candidate reason codes. */
  includeUnassignedLog?: boolean;
  /**
   * When true (default): P1→P2→P3→NP rounds, each zone N/S/E/W (EduTech flow).
   * When false: legacy single pass — any of zone1/2/3 may match requirement.zone.
   */
  phasedPreference?: boolean;
  /**
   * When true: run the old two-phase Node script (zone on `requirements_zone_calculated`, then business on `requirements`),
   * using nested `seq_*` tables with `execute = 1` and the script’s movement logic. Ignores phasedPreference, preferSuggestedIc, maxPerIc, HR role rules.
   */
  useLegacyTwoPhaseScript?: boolean;
};
