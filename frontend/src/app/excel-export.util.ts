import { auditFinalMatchRow, type FinalMatchReportRow } from "./final-match-audit.util";

/** Build CSV with UTF-8 BOM so Excel opens special characters correctly. */

function escapeCsvCell(v: unknown): string {
  if (v == null) return "";
  const s = String(v);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

export function downloadExcelCsv(headers: string[], dataRows: unknown[][], filenameBase: string): void {
  const lines = [
    headers.map(escapeCsvCell).join(","),
    ...dataRows.map((r) => r.map(escapeCsvCell).join(","))
  ];
  const bom = "\uFEFF";
  const blob = new Blob([bom + lines.join("\r\n")], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const safe = filenameBase.replace(/[^\w\-]+/g, "_").replace(/_+/g, "_").slice(0, 120);
  a.download = `${safe || "export"}.csv`;
  a.click();
  URL.revokeObjectURL(a.href);
}

export type AssignmentExportRow = {
  candidateId?: number;
  requirementId?: number;
  meritscore: number;
  email: string;
  profile?: string;
  discipline?: string;
  gender?: string;
  candidateSuitable?: string | null;
  zone: string;
  business: string;
  icname: string;
  suggestedIcMatch?: boolean;
  suggestedIc?: string;
  requirementRoleName?: string | null;
  servicePreferences?: string;
  roleSuitability?: string;
  preferencePhase?: string;
  zone1?: string;
  zone2?: string;
  zone3?: string;
  business1?: string;
  business2?: string;
  business3?: string;
  eligibilityVerdict?: string;
  zoneMatchBasis?: string;
  businessMatchBasis?: string;
  eligiblePoolSize?: number;
  eligibleRank?: number;
  topEligibleCandidateId?: number | null;
  topEligibleCandidateEmail?: string | null;
  requirementRemainingBefore?: number;
  requirementRemainingAfter?: number;
  permanentState?: string;
  permanentZone?: string;
  sameAsP1?: boolean | null;
  hrRelaxedSecondPass?: boolean;
  requirementGender?: string;
  genderRelaxedThirdPass?: boolean;
};

export function buildAssignmentExport(
  items: { row: AssignmentExportRow; origIndex: number }[]
): { headers: string[]; dataRows: unknown[][] } {
  const headers = [
    "Email Ids",
    "Requirement_Discipline",
    "Profile",
    "Gender",
    "candidate_suitable",
    "suggested_ic",
    "Zone1",
    "Zone2",
    "Zone3",
    "Business1",
    "Business2",
    "Business3",
    "Merit",
    "Allocated IC",
    "Allocation Zone",
    "Allocation Role Name",
    "Student Discipline",
    "Candidate Name",
    "Logs (Allocation Priority ---- Requirement Mapped)",
    "Candidate ID",
    "Requirement Row ID",
    "Eligibility Verdict",
    "Zone Match Basis",
    "Business Match Basis",
    "Eligible Pool Size",
    "Rank in Eligible Pool",
    "Top Eligible Candidate",
    "Remaining Before",
    "Remaining After",
    "Complete",
    "Combination-Key1",
    "Batch",
    "Combination-Key2 (Allocated)",
    "Permanent State",
    "Permanent Zone",
    "Same as P1",
    "HR role relax (2nd pass)",
    "HR gender relax (3rd pass)"
  ];
  const dataRows = items.map(({ row }) => [
    row.email,
    row.discipline ?? "",
    row.profile ?? "",
    row.gender ?? "",
    row.candidateSuitable ?? "",
    row.suggestedIc ?? "",
    row.zone1 ?? "",
    row.zone2 ?? "",
    row.zone3 ?? "",
    row.business1 ?? "",
    row.business2 ?? "",
    row.business3 ?? "",
    row.meritscore,
    row.icname ?? "",
    row.zone ?? "",
    row.requirementRoleName ?? "",
    row.discipline ?? "",
    "—",
    `${row.preferencePhase ?? "ANY"} ---- ${(row.zone ?? "—") + " / " + (row.business ?? "—") + " / " + (row.icname ?? "—")}`,
    row.candidateId ?? "",
    row.requirementId ?? "",
    row.eligibilityVerdict ?? "MATCHED",
    row.zoneMatchBasis ?? "",
    row.businessMatchBasis ?? "",
    row.eligiblePoolSize ?? "",
    row.eligibleRank ?? "",
    `${row.topEligibleCandidateId ?? "—"} / ${row.topEligibleCandidateEmail ?? "—"}`,
    row.requirementRemainingBefore ?? "",
    row.requirementRemainingAfter ?? "",
    "Yes",
    `${row.profile ?? "—"}|${row.discipline ?? "—"}|${row.gender ?? "—"}|${row.requirementRoleName ?? "—"}`,
    "—",
    `${row.zone ?? "—"}|${row.business ?? "—"}|${row.icname ?? "—"}|${row.requirementRoleName ?? "—"}`,
    row.permanentState ?? "",
    row.permanentZone ?? "",
    row.sameAsP1 == null ? "—" : row.sameAsP1 ? "True" : "False",
    row.hrRelaxedSecondPass ? "Yes" : "",
    row.genderRelaxedThirdPass ? "Yes" : ""
  ]);
  return { headers, dataRows };
}

/**
 * Single “final” report after allocation (including HR-relax second pass rows): requirement seat line,
 * candidate zones/businesses/HR suitability, and where they were allocated (IC, zone, role).
 */
export function buildFinalAllocationMatchReport(
  items: { row: AssignmentExportRow; origIndex: number }[]
): { headers: string[]; dataRows: unknown[][] } {
  const headers = [
    "Requirement row ID",
    "Req profile",
    "Req discipline",
    "Req gender",
    "Requirement IC",
    "Req zone",
    "Req business",
    "Req role (seat line)",
    "Candidate ID",
    "Email",
    "Merit",
    "Cand profile",
    "Cand discipline",
    "Cand gender",
    "candidate_suitable (Cand HR role)",
    "Cand zone1",
    "Cand zone2",
    "Cand zone3",
    "Cand business1",
    "Cand business2",
    "Cand business3",
    "Cand suggested_ic",
    "Cand service prefs (B1·B2·B3)",
    "Cand permanent zone",
    "Cand permanent state",
    "Allocated IC",
    "Allocated zone",
    "Allocated business",
    "Allocated role (seat)",
    "Preference phase",
    "Zone match basis",
    "Business match basis",
    "Role fit (primary rules)",
    "Suggested IC matched",
    "HR role relax (2nd pass)",
    "HR gender relax (3rd pass)",
    "Check: Bus. match (Y/N)",
    "Check: Zone match (Y/N)",
    "Check: HR role match (Y/N)",
    "Check: Gender match (Y/N)",
    "Check: Row all OK (Y/N)",
    "Eligible pool size",
    "Rank in eligible pool",
    "Top eligible candidate ID",
    "Top eligible candidate email",
    "Seat remaining before",
    "Seat remaining after"
  ];
  const dataRows = items.map(({ row }) => {
    const r = row as FinalMatchReportRow;
    const a = auditFinalMatchRow(r);
    return [
      row.requirementId ?? "",
      row.profile ?? "",
      row.discipline ?? "",
      row.requirementGender ?? row.gender ?? "",
      row.icname ?? "",
      row.zone ?? "",
      row.business ?? "",
      row.requirementRoleName ?? "",
      row.candidateId ?? "",
      row.email,
      row.meritscore,
      row.profile ?? "",
      row.discipline ?? "",
      row.gender ?? "",
      row.candidateSuitable ?? "",
      row.zone1 ?? "",
      row.zone2 ?? "",
      row.zone3 ?? "",
      row.business1 ?? "",
      row.business2 ?? "",
      row.business3 ?? "",
      row.suggestedIc ?? "",
      row.servicePreferences ?? "",
      row.permanentZone ?? "",
      row.permanentState ?? "",
      row.icname ?? "",
      row.zone ?? "",
      row.business ?? "",
      row.requirementRoleName ?? "",
      row.preferencePhase ?? "",
      row.zoneMatchBasis ?? "",
      row.businessMatchBasis ?? "",
      row.roleSuitability ?? "",
      row.suggestedIcMatch ? "Yes" : "No",
      row.hrRelaxedSecondPass ? "Yes" : "No",
      row.genderRelaxedThirdPass ? "Yes" : "No",
      a.businessOk ? "Yes" : "No",
      a.zoneOk ? "Yes" : "No",
      a.hrRoleLineOk && a.hrOk ? "Yes" : "No",
      a.genderLineOk ? "Yes" : "No",
      a.allOk ? "Yes" : "No",
      row.eligiblePoolSize ?? "",
      row.eligibleRank ?? "",
      row.topEligibleCandidateId ?? "",
      row.topEligibleCandidateEmail ?? "",
      row.requirementRemainingBefore ?? "",
      row.requirementRemainingAfter ?? ""
    ];
  });
  return { headers, dataRows };
}

export type UnassignedExportRow = {
  candidateId?: number;
  meritscore: number;
  email: string;
  reasonCode: string;
  detail: string;
  detailBullets?: string[];
  profile?: string;
  discipline?: string;
  gender?: string;
  candidateSuitable?: string | null;
  suggestedIc?: string | null;
  requirementRoleName?: string | null;
  zone1?: string;
  zone2?: string;
  zone3?: string;
  business1?: string;
  business2?: string;
  business3?: string;
  permanentState?: string;
  permanentZone?: string;
  sameAsP1?: boolean | null;
};

export function buildUnassignedExport(
  items: { row: UnassignedExportRow; origIndex: number }[]
): { headers: string[]; dataRows: unknown[][] } {
  const headers = [
    "Email Ids",
    "Requirement_Discipline",
    "Profile",
    "Gender",
    "candidate_suitable",
    "suggested_ic",
    "Zone1",
    "Zone2",
    "Zone3",
    "Business1",
    "Business2",
    "Business3",
    "Merit",
    "Allocated IC",
    "Allocation Zone",
    "Allocation Role Name",
    "Student Discipline",
    "Candidate Name",
    "Logs (Allocation Priority ---- Requirement Mapped)",
    "Candidate ID",
    "Requirement Row ID",
    "Eligibility Verdict",
    "Failure Reason Code",
    "Failure Reason Detail",
    "Complete",
    "Combination-Key1",
    "Batch",
    "Combination-Key2 (Allocated)",
    "Permanent State",
    "Permanent Zone",
    "Same as P1"
  ];
  const dataRows = items.map(({ row }) => [
    row.email,
    row.discipline ?? "",
    row.profile ?? "",
    row.gender ?? "",
    row.candidateSuitable ?? "",
    row.suggestedIc ?? "",
    row.zone1 ?? "",
    row.zone2 ?? "",
    row.zone3 ?? "",
    row.business1 ?? "",
    row.business2 ?? "",
    row.business3 ?? "",
    row.meritscore,
    "—",
    "—",
    "—",
    row.discipline ?? "",
    "—",
    `${row.reasonCode} ---- ${row.detail}`,
    row.candidateId ?? "",
    "—",
    "NOT_ASSIGNED",
    row.reasonCode,
    [row.detail, ...(row.detailBullets ?? [])].join(" | "),
    "No",
    `${row.profile ?? "—"}|${row.discipline ?? "—"}|${row.gender ?? "—"}|—`,
    "—",
    "—",
    row.permanentState ?? "",
    row.permanentZone ?? "",
    row.sameAsP1 == null ? "—" : row.sameAsP1 ? "True" : "False"
  ]);
  return { headers, dataRows };
}
