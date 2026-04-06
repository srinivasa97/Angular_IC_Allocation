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
  /** If true, ignore requirements.role_name vs candidate_suitable (merit+zone+business only). */
  ignoreRoleSuitability?: boolean;
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
