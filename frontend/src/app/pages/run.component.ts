import { Component, inject, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DecimalPipe, JsonPipe, NgFor, NgIf } from "@angular/common";
import { ApiService, type AllocationFilterOptions } from "../api.service";
import { ASSIGNMENT_FILTER_COLS, filterRowsIndexed, type ColumnFilterDef } from "../table-filter.util";
import { buildAssignmentExport, downloadExcelCsv } from "../excel-export.util";

type RunAssignment = {
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

type UnassignedSummary = {
  totalUnassigned: number;
  neverEligibleForAnyRequirement: number;
  eligibleButNotAssigned: number;
  totalSlotsInRun: number;
  skippedSlotsNoCandidate: number;
  skippedSlotsDueToIcCap: number;
  explanation: string;
};

type RunResult = {
  mode?: string;
  assigned?: number;
  unassigned?: number;
  candidatesConsidered?: number;
  requirementsConsidered?: number;
  assignments?: RunAssignment[];
  legacyTwoPhaseScript?: boolean;
  businessAssignments?: RunAssignment[];
  zoneAssignments?: RunAssignment[];
  unassignedSummary?: UnassignedSummary;
  /** Present for legacy two-phase runs. */
  allocationStrategy?: { mode?: string; order?: string };
  profilesMissingRequirements?: Array<{ profile: string; candidateCount: number; message: string }>;
  error?: string;
};

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgFor, NgIf, DecimalPipe],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Run allocation</h2>
          <p class="page-desc">
            Executes the same engine as the simulator but persists assignments to the database. Confirm before running.
          </p>
        </div>
      </div>

      <div class="filter-row" *ngIf="filterOptionsLoaded">
        <label>
          Gender
          <select
            [(ngModel)]="payload['gender']"
            class="sel"
            (ngModelChange)="onFilterContextChange()"
          >
            <option value="">— All —</option>
            <option *ngFor="let g of filterOptions.genders" [value]="g">{{ g }}</option>
          </select>
        </label>
        <label>
          Profile
          <select
            [(ngModel)]="payload['profile']"
            class="sel"
            (ngModelChange)="onFilterContextChange()"
          >
            <option value="">— All —</option>
            <option *ngFor="let p of filterOptions.profiles" [value]="p">{{ p }}</option>
          </select>
        </label>
        <label>
          Discipline
          <span class="hint">Filtered by profile + gender when set.</span>
          <select
            [(ngModel)]="payload['discipline']"
            class="sel wide"
            (ngModelChange)="onFilterContextChange()"
          >
            <option value="">— All —</option>
            <option *ngFor="let d of filterOptions.disciplines" [value]="d">{{ d }}</option>
          </select>
        </label>
      </div>
      <ul *ngIf="filterOptionsLoaded && !filterOptionsError" class="filter-slice-stats">
        <li>
          <strong>{{ filterOptions.requirementSlice.requirementRowCount }}</strong> requirement row(s) with
          <code>newvalue > 0</code> for current filters (capacity basis for a fresh simulate with these filters).
        </li>
        <li>
          <strong>{{ filterOptions.requirementSlice.totalSeatsNewvalue | number : "1.0-0" }}</strong> total seats
          (sum of <code>newvalue</code> on those rows). Production run uses <code>remaining</code> instead.
        </li>
      </ul>
      <p *ngIf="!filterOptionsLoaded && !filterOptionsError" class="muted">Loading filter lists…</p>
      <p *ngIf="filterOptionsError" class="alert alert-error" style="margin-top:0;">{{ filterOptionsError }}</p>

      <div class="form-stack">
        <label class="form-check">
          <input type="checkbox" [(ngModel)]="payload['resetBeforeRun']" />
          Reset previous auto allocations before run
        </label>
        <label class="form-field inline">
          <span>Max per IC (optional)</span>
          <input type="number" min="1" style="max-width: 8rem;" [(ngModel)]="payload['maxPerIc']" placeholder="No cap" />
        </label>
        <label class="form-check">
          <input type="checkbox" [(ngModel)]="payload['preferSuggestedIc']" />
          Prefer HR suggested IC
        </label>
        <label class="form-check">
          <input type="checkbox" [(ngModel)]="payload['ignoreRoleSuitability']" />
          Ignore HR role suitability
        </label>
        <label
          class="form-check"
          title="Old Node flow: zones then business; requires requirements_zone_calculated."
        >
          <input type="checkbox" [(ngModel)]="payload['useLegacyTwoPhaseScript']" />
          Legacy two-phase script (zones → business)
        </label>
      </div>

      <div style="margin-top: 20px;">
        <button type="button" class="btn btn-primary" (click)="run()" [disabled]="loading">
          {{ loading ? "Running…" : "Run allocation" }}
        </button>
      </div>

      <ng-container *ngIf="parsedResult as r">
        <p *ngIf="r.allocationStrategy" class="strategy-banner">
          <strong>Strategy:</strong> {{ r.allocationStrategy.mode }} — {{ r.allocationStrategy.order }}
        </p>

        <div class="kpi-grid" style="margin-top: 20px;">
          <div class="kpi-tile accent">
            <span class="kpi-label">Assigned</span>
            <span class="kpi-value">{{ r.assigned ?? "—" }}</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Unassigned</span>
            <span class="kpi-value">{{ r.unassigned ?? "—" }}</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Candidates</span>
            <span class="kpi-value">{{ r.candidatesConsidered ?? "—" }}</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Requirement rows</span>
            <span class="kpi-value">{{ r.requirementsConsidered ?? "—" }}</span>
          </div>
        </div>

        <section *ngIf="r.profilesMissingRequirements?.length" style="margin-top: 20px; padding: 12px 14px; background: #fff7ed; border: 1px solid #fdba74; border-radius: 8px;">
          <h3 class="page-title" style="font-size: 1rem;">Profiles with no requirement rows</h3>
          <p class="page-desc" style="margin-top: 6px;">
            Candidates use these profiles but <code>requirements</code> has no matching rows (with current filters).
          </p>
          <ul style="margin: 8px 0 0; padding-left: 1.2rem;">
            <li *ngFor="let row of r.profilesMissingRequirements!" style="margin-bottom: 6px;">
              <strong>{{ row.profile }}</strong> — {{ row.candidateCount }} candidate(s). {{ row.message }}
            </li>
          </ul>
        </section>

        <section *ngIf="r.unassignedSummary" style="margin-top: 24px;">
          <h3 class="page-title" style="font-size: 1rem;">Unassigned summary</h3>
          <p class="page-desc" style="margin-top: 6px;">{{ r.unassignedSummary.explanation }}</p>
          <div class="mini-grid">
            <div>Never eligible: <strong>{{ r.unassignedSummary.neverEligibleForAnyRequirement }}</strong></div>
            <div>Eligible, no seat: <strong>{{ r.unassignedSummary.eligibleButNotAssigned }}</strong></div>
            <div>Total seats: <strong>{{ r.unassignedSummary.totalSlotsInRun }}</strong></div>
            <div>Skipped (no candidate): <strong>{{ r.unassignedSummary.skippedSlotsNoCandidate }}</strong></div>
            <div>Skipped (IC cap): <strong>{{ r.unassignedSummary.skippedSlotsDueToIcCap }}</strong></div>
          </div>
        </section>

        <p *ngIf="r.legacyTwoPhaseScript" class="page-desc" style="margin-top: 12px;">
          Legacy two-phase: table shows <strong>business</strong> rows (IC names) when present;
          zone-only steps are in <code>zoneAssignments</code> in raw JSON.
        </p>

        <section *ngIf="r.assignments?.length" style="margin-top: 24px;">
          <h3 class="page-title" style="font-size: 1rem;">Assignments ({{ runAssignmentsForTable.length }} shown)</h3>
          <p class="page-desc" style="margin: 4px 0 10px;">
            Search any column or use per-column filters to compare with another script’s output.
            <strong>Export Excel</strong> saves <em>visible</em> rows as UTF-8 CSV (opens in Excel).
          </p>
          <div class="table-filter-toolbar">
            <input
              type="search"
              class="table-filter-global"
              [(ngModel)]="runAssignGlobal"
              placeholder="Search all columns…"
              aria-label="Search assignments"
            />
            <button type="button" class="btn btn-secondary" (click)="showRunAssignColFilters = !showRunAssignColFilters">
              {{ showRunAssignColFilters ? "Hide" : "Show" }} column filters
            </button>
            <button type="button" class="btn btn-secondary" (click)="clearRunAssignFilters()">Clear</button>
            <button type="button" class="btn btn-primary" (click)="exportRunAssignmentsExcel()">Export Excel</button>
            <span class="muted">{{ filteredRunAssignmentItems.length }} / {{ runAssignmentsForTable.length }} rows</span>
          </div>
          <div class="col-filters-grid" *ngIf="showRunAssignColFilters">
            <label *ngFor="let c of runAssignmentFilterCols">
              {{ c.label }}
              <input type="text" [(ngModel)]="runAssignCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
            </label>
          </div>
          <div class="data-table-wrap data-table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Merit</th>
                  <th>Profile</th>
                  <th>Discipline</th>
                  <th>Gender</th>
                  <th>Service prefs</th>
                  <th>Email</th>
                  <th>Zone</th>
                  <th>Business (seat)</th>
                  <th>IC (seat)</th>
                  <th>Phase</th>
                  <th>Suggested IC</th>
                  <th>HR sugg. name</th>
                  <th>Role fit</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredRunAssignmentItems">
                  <td class="cell-tight">{{ item.origIndex + 1 }}</td>
                  <td class="cell-num">{{ item.row.meritscore | number : "1.2-2" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.profile ?? ''">{{ item.row.profile || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.discipline ?? ''">{{ item.row.discipline || "—" }}</td>
                  <td class="cell-tight">{{ item.row.gender || "—" }}</td>
                  <td class="cell-wide" [attr.title]="item.row.servicePreferences ?? ''">
                    {{ item.row.servicePreferences || "—" }}
                  </td>
                  <td class="cell-clip" [attr.title]="item.row.email">{{ item.row.email }}</td>
                  <td class="cell-tight">{{ item.row.zone }}</td>
                  <td class="cell-clip" [attr.title]="item.row.business">{{ item.row.business }}</td>
                  <td class="cell-clip" [attr.title]="item.row.icname">{{ item.row.icname }}</td>
                  <td class="cell-tight"><code>{{ item.row.preferencePhase ?? "—" }}</code></td>
                  <td class="cell-tight">{{ item.row.suggestedIcMatch ? "Yes" : "No" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.suggestedIc ?? ''">{{ item.row.suggestedIc || "—" }}</td>
                  <td class="cell-tight">{{ item.row.roleSuitability ?? "—" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>
      </ng-container>

      <p *ngIf="errorMessage" class="alert alert-error">{{ errorMessage }}</p>

      <label class="form-check" style="margin-top: 20px;">
        <input type="checkbox" [(ngModel)]="showRaw" />
        Show raw JSON response
      </label>
      <pre *ngIf="showRaw && result != null" class="raw-json">{{ result | json }}</pre>
    </div>
  `,
  styles: [
    `
      .filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: flex-end;
        margin-bottom: 16px;
      }
      .filter-row label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 0.8125rem;
        font-weight: 600;
        color: var(--color-text-muted);
      }
      .filter-row .hint {
        font-weight: 400;
        font-size: 0.6875rem;
        color: var(--color-text-muted);
      }
      .sel {
        min-width: 9rem;
      }
      .sel.wide {
        min-width: 14rem;
        max-width: 22rem;
      }
      .form-stack {
        display: flex;
        flex-direction: column;
        gap: 12px;
        align-items: flex-start;
      }
      .form-field.inline {
        flex-direction: row;
        align-items: center;
        gap: 12px;
      }
      .form-field.inline span {
        min-width: 10rem;
        font-size: 0.875rem;
        font-weight: 600;
        color: var(--color-text-muted);
      }
      .mini-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
        gap: 8px;
        font-size: 0.875rem;
        margin-top: 12px;
      }
      .strategy-banner {
        margin: 16px 0 0;
        padding: 12px 14px;
        font-size: 0.8125rem;
        line-height: 1.45;
        background: var(--color-primary-soft);
        border: 1px solid #bfdbfe;
        border-radius: var(--radius-md);
      }
      .filter-slice-stats {
        margin: 0 0 12px;
        padding-left: 1.2rem;
        font-size: 0.8125rem;
        line-height: 1.5;
        color: var(--color-text-muted, #5c6b7e);
      }
      .filter-slice-stats li {
        margin-bottom: 4px;
      }
      .filter-slice-stats code {
        font-size: 0.75rem;
      }
    `
  ]
})
export class RunComponent implements OnInit {
  private readonly api = inject(ApiService);
  payload: Record<string, unknown> = {
    gender: "",
    profile: "",
    discipline: "",
    resetBeforeRun: false,
    preferSuggestedIc: true,
    ignoreRoleSuitability: false,
    useLegacyTwoPhaseScript: false
  };
  filterOptions: AllocationFilterOptions = {
    genders: [],
    profiles: [],
    disciplines: [],
    requirementSlice: { requirementRowCount: 0, totalSeatsNewvalue: 0 }
  };
  filterOptionsLoaded = false;
  filterOptionsError = "";
  result: unknown;
  loading = false;
  showRaw = false;

  readonly runAssignmentFilterCols = ASSIGNMENT_FILTER_COLS;
  runAssignGlobal = "";
  runAssignCol: Record<string, string> = {};
  showRunAssignColFilters = false;

  get runAssignmentsForTable(): RunAssignment[] {
    const r = this.parsedResult;
    if (!r?.assignments?.length) return [];
    if (r.legacyTwoPhaseScript && r.businessAssignments?.length) {
      return r.businessAssignments;
    }
    return r.assignments;
  }

  get filteredRunAssignmentItems(): { row: RunAssignment; origIndex: number }[] {
    const rows = this.runAssignmentsForTable;
    return filterRowsIndexed(
      rows,
      ASSIGNMENT_FILTER_COLS as ColumnFilterDef<RunAssignment>[],
      this.runAssignGlobal,
      this.runAssignCol
    );
  }

  clearRunAssignFilters(): void {
    this.runAssignGlobal = "";
    this.runAssignCol = {};
  }

  exportRunAssignmentsExcel(): void {
    const items = this.filteredRunAssignmentItems;
    if (!items.length) return;
    const { headers, dataRows } = buildAssignmentExport(items);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadExcelCsv(headers, dataRows, `run-assignments-${stamp}`);
  }

  get parsedResult(): RunResult | null {
    if (!this.result || typeof this.result !== "object") return null;
    const o = this.result as RunResult;
    if ("error" in o && typeof o.error === "string") return null;
    return o;
  }

  get errorMessage(): string {
    if (!this.result || typeof this.result !== "object") return "";
    const o = this.result as RunResult;
    if (typeof o.error === "string") return o.error;
    return "";
  }

  ngOnInit(): void {
    this.api.allocationFilterOptions().subscribe({
      next: (opts) => {
        this.filterOptions = opts;
        this.filterOptionsLoaded = true;
      },
      error: (e) => {
        this.filterOptionsError = e?.error?.error ?? e?.message ?? "Could not load filter lists";
        this.filterOptionsLoaded = true;
      }
    });
  }

  onFilterContextChange(): void {
    const profile = String(this.payload["profile"] ?? "").trim();
    const gender = String(this.payload["gender"] ?? "").trim();
    const discipline = String(this.payload["discipline"] ?? "").trim();
    this.api
      .allocationFilterOptions({
        profile: profile || undefined,
        gender: gender || undefined,
        discipline: discipline || undefined
      })
      .subscribe({
        next: (opts) => {
          this.filterOptions.disciplines = opts.disciplines;
          this.filterOptions.requirementSlice = opts.requirementSlice;
          const cur = String(this.payload["discipline"] ?? "");
          if (cur && !opts.disciplines.includes(cur)) {
            this.payload["discipline"] = "";
            this.onFilterContextChange();
          }
        }
      });
  }

  private sanitizePayload(): Record<string, unknown> {
    const body: Record<string, unknown> = { ...this.payload };
    for (const k of ["gender", "profile", "discipline"] as const) {
      const v = body[k];
      if (v === "" || v === undefined || v === null) delete body[k];
    }
    return body;
  }

  run(): void {
    if (!confirm("Run allocation now? This will write to the database.")) return;
    this.loading = true;
    this.result = null;
    this.clearRunAssignFilters();
    this.showRunAssignColFilters = false;
    this.api.run(this.sanitizePayload()).subscribe({
      next: (res) => {
        this.result = res;
        this.loading = false;
      },
      error: (e) => {
        const err = e?.error;
        this.result =
          typeof err === "string"
            ? { error: err }
            : err && typeof err === "object"
              ? err
              : { error: e?.message ?? "Request failed" };
        this.loading = false;
      }
    });
  }
}
