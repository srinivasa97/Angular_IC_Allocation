/** Client-side table filters: global substring (any column) AND per-column substrings. */

export type ColumnFilterDef<T> = {
  key: string;
  label: string;
  text: (row: T, origIndex: number) => string;
};

function rowMatches<T>(
  row: T,
  origIndex: number,
  cols: ColumnFilterDef<T>[],
  global: string,
  perKey: Record<string, string>
): boolean {
  const activeCols = Object.entries(perKey)
    .map(([k, v]) => [k, v.trim().toLowerCase()] as const)
    .filter(([, v]) => v.length > 0);
  for (const [k, fv] of activeCols) {
    const def = cols.find((c) => c.key === k);
    if (!def) continue;
    if (!def.text(row, origIndex).toLowerCase().includes(fv)) return false;
  }
  const g = global.trim().toLowerCase();
  if (g) {
    if (!cols.some((c) => c.text(row, origIndex).toLowerCase().includes(g))) return false;
  }
  return true;
}

export function filterRowsIndexed<T>(
  rows: T[],
  cols: ColumnFilterDef<T>[],
  global: string,
  perKey: Record<string, string>
): { row: T; origIndex: number }[] {
  const out: { row: T; origIndex: number }[] = [];
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (rowMatches(row, i, cols, global, perKey)) out.push({ row, origIndex: i });
  }
  return out;
}

export type AssignmentFilterRow = {
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

export const ASSIGNMENT_FILTER_COLS: ColumnFilterDef<AssignmentFilterRow>[] = [
  { key: "_row", label: "#", text: (_r, i) => String(i + 1) },
  { key: "meritscore", label: "Merit", text: (r) => String(r.meritscore ?? "") },
  { key: "profile", label: "Profile", text: (r) => String(r.profile ?? "") },
  { key: "discipline", label: "Discipline", text: (r) => String(r.discipline ?? "") },
  { key: "gender", label: "Gender", text: (r) => String(r.gender ?? "") },
  { key: "servicePreferences", label: "Service prefs", text: (r) => String(r.servicePreferences ?? "") },
  { key: "email", label: "Email", text: (r) => String(r.email ?? "") },
  { key: "zone", label: "Zone", text: (r) => String(r.zone ?? "") },
  { key: "business", label: "Business (seat)", text: (r) => String(r.business ?? "") },
  { key: "icname", label: "IC (seat)", text: (r) => String(r.icname ?? "") },
  { key: "preferencePhase", label: "Phase", text: (r) => String(r.preferencePhase ?? "") },
  {
    key: "suggestedIcMatch",
    label: "Suggested IC",
    text: (r) => (r.suggestedIcMatch ? "yes" : "no")
  },
  { key: "suggestedIc", label: "HR sugg. name", text: (r) => String(r.suggestedIc ?? "") },
  { key: "roleSuitability", label: "Role fit", text: (r) => String(r.roleSuitability ?? "") }
];

export type UnassignedFilterRow = {
  meritscore: number;
  email: string;
  reasonCode: string;
  detail: string;
  detailBullets?: string[];
};

export const UNASSIGNED_FILTER_COLS: ColumnFilterDef<UnassignedFilterRow>[] = [
  { key: "meritscore", label: "Merit", text: (r) => String(r.meritscore ?? "") },
  { key: "email", label: "Email", text: (r) => String(r.email ?? "") },
  { key: "reasonCode", label: "Reason", text: (r) => String(r.reasonCode ?? "") },
  {
    key: "detail",
    label: "Detail",
    text: (r) => [r.detail ?? "", ...(r.detailBullets ?? [])].join(" ")
  }
];

export type TraceFilterRow = { step: string; detail: Record<string, unknown> | undefined };

export const TRACE_FILTER_COLS: ColumnFilterDef<TraceFilterRow>[] = [
  { key: "step", label: "Step", text: (r) => String(r.step ?? "") },
  {
    key: "detail",
    label: "Detail",
    text: (r) => (r.detail == null ? "" : JSON.stringify(r.detail))
  }
];

export function formatCellForFilter(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function dynamicRecordFilterCols(keys: string[]): ColumnFilterDef<Record<string, unknown>>[] {
  return keys.map((key) => ({
    key,
    label: key.replace(/_/g, " "),
    text: (row) => formatCellForFilter(row[key])
  }));
}

export type TopZoneRow = { zone: string; count: unknown };

export function topZoneFilterCols(): ColumnFilterDef<TopZoneRow>[] {
  return [
    { key: "_row", label: "#", text: (_r, i) => String(i + 1) },
    { key: "zone", label: "Zone", text: (r) => String(r.zone ?? "") },
    { key: "count", label: "Count", text: (r) => String(r.count ?? "") }
  ];
}
