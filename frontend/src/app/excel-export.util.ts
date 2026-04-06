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
  meritscore: number;
  email: string;
  profile?: string;
  discipline?: string;
  gender?: string;
  zone: string;
  business: string;
  icname: string;
  suggestedIcMatch?: boolean;
  suggestedIc?: string;
  servicePreferences?: string;
  roleSuitability?: string;
  preferencePhase?: string;
};

export function buildAssignmentExport(
  items: { row: AssignmentExportRow; origIndex: number }[]
): { headers: string[]; dataRows: unknown[][] } {
  const headers = [
    "#",
    "Merit",
    "Profile",
    "Discipline",
    "Gender",
    "Service preferences",
    "Email",
    "Zone",
    "Business (seat)",
    "IC (seat)",
    "Phase",
    "Suggested IC",
    "HR suggested IC name",
    "Role fit"
  ];
  const dataRows = items.map(({ row, origIndex }) => [
    origIndex + 1,
    row.meritscore,
    row.profile ?? "",
    row.discipline ?? "",
    row.gender ?? "",
    row.servicePreferences ?? "",
    row.email,
    row.zone,
    row.business,
    row.icname,
    row.preferencePhase ?? "",
    row.suggestedIcMatch ? "Yes" : "No",
    row.suggestedIc ?? "",
    row.roleSuitability ?? ""
  ]);
  return { headers, dataRows };
}

export type UnassignedExportRow = {
  meritscore: number;
  email: string;
  reasonCode: string;
  detail: string;
  detailBullets?: string[];
};

export function buildUnassignedExport(
  items: { row: UnassignedExportRow; origIndex: number }[]
): { headers: string[]; dataRows: unknown[][] } {
  const headers = ["#", "Merit", "Email", "Reason code", "Summary", "Detail bullets"];
  const dataRows = items.map(({ row, origIndex }) => [
    origIndex + 1,
    row.meritscore,
    row.email,
    row.reasonCode,
    row.detail,
    (row.detailBullets ?? []).join(" | ")
  ]);
  return { headers, dataRows };
}
