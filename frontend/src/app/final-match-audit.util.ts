/** Row shape needed for requirement vs candidate audit (subset of assignment API). */
export type FinalMatchReportRow = {
  requirementId?: number;
  candidateId?: number;
  email: string;
  meritscore: number;
  profile?: string;
  discipline?: string;
  gender?: string;
  zone: string;
  business: string;
  icname: string;
  requirementRoleName?: string | null;
  candidateSuitable?: string | null;
  zone1?: string;
  zone2?: string;
  zone3?: string;
  business1?: string;
  business2?: string;
  business3?: string;
  suggestedIc?: string;
  servicePreferences?: string;
  permanentZone?: string;
  permanentState?: string;
  zoneMatchBasis?: string;
  businessMatchBasis?: string;
  roleSuitability?: string;
  preferencePhase?: string;
  eligibilityVerdict?: string;
  hrRelaxedSecondPass?: boolean;
  /** Seat line gender on requirement row at pick time. */
  requirementGender?: string;
  genderRelaxedThirdPass?: boolean;
  suggestedIcMatch?: boolean;
};

function norm(s: unknown): string {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

export type FinalMatchAudit = {
  businessOk: boolean;
  zoneOk: boolean;
  hrOk: boolean;
  hrRoleLineOk: boolean;
  genderLineOk: boolean;
  allOk: boolean;
  issues: string[];
};

export function auditFinalMatchRow(row: FinalMatchReportRow): FinalMatchAudit {
  const issues: string[] = [];
  const seatBiz = norm(row.business);
  const businessOk =
    !seatBiz ||
    [row.business1, row.business2, row.business3].some((b) => norm(b) === seatBiz);
  if (!businessOk) issues.push("Seat business is not in candidate business1–3.");

  const zoneOk =
    (row.eligibilityVerdict ?? "MATCHED") === "MATCHED" && Boolean((row.zoneMatchBasis ?? "").trim());
  if (!zoneOk) issues.push("No zone match basis on row.");

  const hrOk = row.roleSuitability !== "ineligible_blank_hr";
  if (!hrOk) issues.push("HR: blank or ineligible candidate_suitable for strict seat.");

  const seatRole = norm(row.requirementRoleName);
  const candRole = norm(row.candidateSuitable);
  const hrRoleLineOk =
    !seatRole ||
    row.hrRelaxedSecondPass === true ||
    row.roleSuitability === "not_required" ||
    candRole === seatRole;
  if (!hrRoleLineOk) issues.push("Seat role_name does not match candidate_suitable (unless HR-relax pass).");

  const seatGender = norm(row.requirementGender);
  const candGender = norm(row.gender);
  const genderLineOk =
    row.genderRelaxedThirdPass === true ||
    !seatGender ||
    !candGender ||
    seatGender === candGender;
  if (!genderLineOk) issues.push("Seat line gender does not match candidate gender (unless gender-relax third pass).");

  const allOk = businessOk && zoneOk && hrOk && hrRoleLineOk && genderLineOk;
  return { businessOk, zoneOk, hrOk, hrRoleLineOk, genderLineOk, allOk, issues };
}
