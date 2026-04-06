import { Component, inject, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DecimalPipe, JsonPipe, NgFor, NgIf } from "@angular/common";
import { ApiService, type AllocationFilterOptions } from "../api.service";
import {
  ASSIGNMENT_FILTER_COLS,
  filterRowsIndexed,
  TRACE_FILTER_COLS,
  UNASSIGNED_FILTER_COLS,
  type ColumnFilterDef
} from "../table-filter.util";
import { buildAssignmentExport, buildUnassignedExport, downloadExcelCsv } from "../excel-export.util";

type SimulateAssignment = {
  candidateId: number;
  email: string;
  meritscore: number;
  profile?: string;
  discipline?: string;
  gender?: string;
  zone: string;
  business: string;
  icname: string;
  suggestedIcMatch?: boolean;
  suggestedIc?: string;
  servicePreferences?: string;
  requirementRoleName?: string | null;
  candidateSuitable?: string | null;
  roleSuitability?: string;
  preferencePhase?: string;
};

type UnassignedDetail = {
  candidateId: number;
  email: string;
  meritscore: number;
  reasonCode: string;
  detail: string;
  detailBullets?: string[];
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

type SimulateResponse = {
  mode?: string;
  assigned?: number;
  unassigned?: number;
  candidatesConsidered?: number;
  requirementsConsidered?: number;
  assignments?: SimulateAssignment[];
  /** Present when `useLegacyTwoPhaseScript` was true (old Node two-phase flow). */
  legacyTwoPhaseScript?: boolean;
  zoneAssignments?: SimulateAssignment[];
  businessAssignments?: SimulateAssignment[];
  unassignedSummary?: UnassignedSummary;
  unassignedDetails?: UnassignedDetail[];
  processingTrace?: Array<{ step: string; detail?: Record<string, unknown> }>;
  fairness?: Record<string, unknown>;
  hrPolicy?: Record<string, unknown>;
  allocationStrategy?: { mode?: string; order?: string };
  matchDiagnostics?: Record<string, unknown>;
  requirementDiagnostics?: Record<string, unknown>;
  /** Unified engine only: how simulated seats relate to requirement capacity. */
  reconciliation?: Record<string, unknown>;
  /** Profiles on candidates with zero matching `requirements` rows (same gender/profile/discipline filters). */
  profilesMissingRequirements?: Array<{ profile: string; candidateCount: number; message: string }>;
};

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgIf, NgFor, DecimalPipe],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Simulation (dry run)</h2>
          <p class="page-desc">
            Preview assignments without writing to the database. Use filters and options to match how you will run production allocation.
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
          <span class="hint">Lists only disciplines for selected profile (and gender, if set).</span>
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
          <strong>{{ filterOptions.requirementSlice.requirementRowCount }}</strong> requirement row(s) with open
          capacity (<code>newvalue > 0</code>) for the current gender / profile / discipline filters — same slice a
          <strong>fresh simulate</strong> loads.
        </li>
        <li>
          <strong>{{ filterOptions.requirementSlice.totalSeatsNewvalue | number : "1.0-0" }}</strong> total seats
          (sum of <code>newvalue</code> on those rows).
        </li>
      </ul>
      <p *ngIf="disciplinesLoading" class="muted" style="margin: 4px 0 0;">Updating discipline list…</p>
      <p *ngIf="!filterOptionsLoaded && !filterOptionsError" class="muted">Loading filter lists…</p>
      <p *ngIf="filterOptionsError" class="alert alert-error" style="margin-top:0;">{{ filterOptionsError }}</p>
      <div class="sim-toolbar">
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['resetBeforeRun']" />
          fresh simulate
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['includeTrace']" />
          trace
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['preferSuggestedIc']" />
          prefer suggested IC
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['ignoreRoleSuitability']" />
          ignore HR role
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['includeUnassignedLog']" />
          unassigned log
        </label>
        <label class="chk" title="EduTech flow: P1→P2→P3→NP, each zone N,S,E,W. Uncheck for legacy any-zone match.">
          <input type="checkbox" [(ngModel)]="payload['phasedPreference']" />
          phased P1→P2→P3→NP
        </label>
        <label
          class="chk"
          title="Match old Node script: zone pass on requirements_zone_calculated, then business on requirements; seq_* with execute=1. Needs that table in MySQL."
        >
          <input type="checkbox" [(ngModel)]="payload['useLegacyTwoPhaseScript']" />
          legacy two-phase script
        </label>
        <input
          type="number"
          min="1"
          class="num-in"
          [(ngModel)]="payload['maxPerIc']"
          placeholder="max per IC"
        />
        <button type="button" class="btn btn-primary" (click)="simulate()" [disabled]="loading">
          {{ loading ? "Running…" : "Simulate" }}
        </button>
      </div>

      <p *ngIf="loading" class="muted">Running simulation…</p>
      <p *ngIf="error" class="alert alert-error">{{ error }}</p>

      <ng-container *ngIf="result">
        <p *ngIf="result?.legacyTwoPhaseScript" class="hint-banner">
          Legacy two-phase: {{ result?.zoneAssignments?.length ?? 0 }} zone-only rows,
          {{ result?.businessAssignments?.length ?? 0 }} business rows (IC names).
          The table below lists <strong>business phase</strong> rows when any exist so the IC column is filled;
          zone-only steps stay in <strong>Raw JSON</strong> (<code>zoneAssignments</code>).
        </p>
        <p *ngIf="result?.allocationStrategy" class="strategy">
          <strong>Strategy:</strong> {{ result?.allocationStrategy?.mode }} — {{ result?.allocationStrategy?.order }}
        </p>
        <p *ngIf="result?.assignments?.length" class="hint-banner">
          <strong>Suggested IC (Yes/No):</strong> “Yes” only when you had
          <strong>prefer suggested IC</strong> on <em>and</em> the chosen candidate’s
          <code>suggested_ic</code> matches the seat’s <code>icname</code>. If that option is off,
          this column is always “No” (pure merit among eligible candidates); the
          <strong>HR sugg. name</strong> column can still show their stored suggestion for reference.
        </p>
        <div class="sim-kpi">
          <div class="kpi"><span class="lbl">Assigned</span><span class="val">{{ result!.assigned ?? "—" }}</span></div>
          <div class="kpi"><span class="lbl">Unassigned</span><span class="val">{{ result!.unassigned ?? "—" }}</span></div>
          <div class="kpi">
            <span class="lbl">Candidates</span><span class="val">{{ result!.candidatesConsidered ?? "—" }}</span>
          </div>
          <div class="kpi">
            <span class="lbl">Req. rows</span><span class="val">{{ result!.requirementsConsidered ?? "—" }}</span>
          </div>
        </div>

        <section *ngIf="result?.reconciliation as rec" class="block">
          <h3>Requirement vs assignment reconciliation</h3>
          <p class="page-desc">
            <strong>Req. rows</strong> is the number of requirement <em>lines</em> after filters. Total
            <strong>seats</strong> are summed from those rows using
            <code>{{ rec["capacityField"] }}</code> (with <strong>reset before run</strong> in simulate, that is
            usually <code>newvalue</code> per row). So seat count can be higher than row count.
          </p>
          <div class="mini-grid">
            <div>Total seat capacity loaded: <strong>{{ rec["totalSeatCapacityLoaded"] }}</strong></div>
            <div>Seats filled (this run): <strong>{{ rec["seatsFilled"] }}</strong></div>
            <div>Seats still open on requirements: <strong>{{ rec["requirementSeatsStillOpen"] }}</strong></div>
            <div>Filled + open = loaded: <strong>{{ rec["capacityEquationHolds"] ? "Yes" : "No" }}</strong></div>
            <div>Skipped (no eligible candidate): <strong>{{ rec["slotsSkippedNoEligibleCandidate"] }}</strong></div>
            <div>Skipped (IC cap): <strong>{{ rec["slotsSkippedDueToIcCap"] }}</strong></div>
            <div>Pool shape: <strong>{{ rec["allocationShape"] }}</strong></div>
          </div>
          <p class="page-desc" style="margin-top: 10px;">{{ rec["exportHint"] }}</p>
          <pre
            *ngIf="rec['verifyAgainstDbSql']"
            class="sql-hint"
            style="white-space: pre-wrap; font-size: 0.85rem; background: var(--panel-2, #f5f5f5); padding: 10px; border-radius: 6px;"
            >{{ rec["verifyAgainstDbSql"] }}</pre
          >
        </section>

        <section *ngIf="result?.profilesMissingRequirements?.length" class="block alert-warn-soft">
          <h3>Profiles with no requirement rows</h3>
          <p class="page-desc">
            These profiles appear on candidates in the current pool, but the <code>requirements</code> table has
            <strong>no rows</strong> for that profile (after your gender / profile / discipline filters). Those
            people cannot be allocated until you add requirements.
          </p>
          <ul class="profile-gap-list">
            <li *ngFor="let row of result!.profilesMissingRequirements!">
              <strong>{{ row.profile }}</strong> — {{ row.candidateCount }} candidate(s). {{ row.message }}
            </li>
          </ul>
        </section>

        <section *ngIf="result?.unassignedSummary" class="block">
          <h3>Why some are unassigned</h3>
          <p class="explain">{{ result?.unassignedSummary?.explanation }}</p>
          <div class="mini-grid">
            <div>Never eligible (no row match): <strong>{{ result?.unassignedSummary?.neverEligibleForAnyRequirement }}</strong></div>
            <div>Eligible but no seat / outranked: <strong>{{ result?.unassignedSummary?.eligibleButNotAssigned }}</strong></div>
            <div>Total seats this run: <strong>{{ result?.unassignedSummary?.totalSlotsInRun }}</strong></div>
            <div>Slots skipped (no candidate): <strong>{{ result?.unassignedSummary?.skippedSlotsNoCandidate }}</strong></div>
            <div>Slots skipped (IC cap): <strong>{{ result?.unassignedSummary?.skippedSlotsDueToIcCap }}</strong></div>
          </div>
        </section>

        <section *ngIf="result!.assignments?.length" class="block">
          <h3>Assignments ({{ assignmentsForTable.length }} shown)</h3>
          <p class="page-desc" style="margin: 4px 0 10px;">
            Filter rows to cross-check against another script. Search matches any column; column filters must all match (case-insensitive contains).
            <strong>Export Excel</strong> downloads the <em>visible</em> rows as a UTF-8 CSV (opens in Excel).
          </p>
          <div class="table-filter-toolbar">
            <input
              type="search"
              class="table-filter-global"
              [(ngModel)]="assignGlobal"
              placeholder="Search all columns…"
              aria-label="Search assignments"
            />
            <button type="button" class="btn btn-secondary" (click)="showAssignColFilters = !showAssignColFilters">
              {{ showAssignColFilters ? "Hide" : "Show" }} column filters
            </button>
            <button type="button" class="btn btn-secondary" (click)="clearAssignFilters()">Clear</button>
            <button type="button" class="btn btn-primary" (click)="exportAssignmentsExcel()">Export Excel</button>
            <span class="muted">{{ filteredAssignmentItems.length }} / {{ assignmentsForTable.length }} rows</span>
          </div>
          <div class="col-filters-grid" *ngIf="showAssignColFilters">
            <label *ngFor="let c of assignmentFilterCols">
              {{ c.label }}
              <input type="text" [(ngModel)]="assignCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
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
                <tr *ngFor="let item of filteredAssignmentItems">
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

        <section *ngIf="result!.unassignedDetails?.length" class="block">
          <h3>Unassigned detail ({{ result!.unassignedDetails!.length }} shown)</h3>
          <div class="table-filter-toolbar">
            <input
              type="search"
              class="table-filter-global"
              [(ngModel)]="unassignGlobal"
              placeholder="Search unassigned rows…"
              aria-label="Search unassigned"
            />
            <button type="button" class="btn btn-secondary" (click)="showUnassignColFilters = !showUnassignColFilters">
              {{ showUnassignColFilters ? "Hide" : "Show" }} column filters
            </button>
            <button type="button" class="btn btn-secondary" (click)="clearUnassignFilters()">Clear</button>
            <button type="button" class="btn btn-primary" (click)="exportUnassignedExcel()">Export Excel</button>
            <span class="muted">{{ filteredUnassignedItems.length }} / {{ result!.unassignedDetails!.length }} rows</span>
          </div>
          <div class="col-filters-grid" *ngIf="showUnassignColFilters">
            <label *ngFor="let c of unassignedFilterCols">
              {{ c.label }}
              <input type="text" [(ngModel)]="unassignCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
            </label>
          </div>
          <div class="data-table-wrap data-table-scroll">
            <table class="data-table">
              <thead>
                <tr>
                  <th>Merit</th>
                  <th>Email</th>
                  <th>Reason</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredUnassignedItems">
                  <td class="cell-num">{{ item.row.meritscore | number : "1.2-2" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.email">{{ item.row.email }}</td>
                  <td class="cell-tight"><code>{{ item.row.reasonCode }}</code></td>
                  <td class="cell-wide unassigned-detail-cell">
                    <div class="unassigned-summary">{{ item.row.detail }}</div>
                    <ul *ngIf="item.row.detailBullets?.length" class="unassigned-bullets">
                      <li *ngFor="let b of item.row.detailBullets">{{ b }}</li>
                    </ul>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section *ngIf="result!.processingTrace?.length" class="block">
          <h3>Processing steps</h3>
          <div class="table-filter-toolbar">
            <input
              type="search"
              class="table-filter-global"
              [(ngModel)]="traceGlobal"
              placeholder="Search step or detail JSON…"
              aria-label="Search trace"
            />
            <button type="button" class="btn btn-secondary" (click)="showTraceColFilters = !showTraceColFilters">
              {{ showTraceColFilters ? "Hide" : "Show" }} column filters
            </button>
            <button type="button" class="btn btn-secondary" (click)="clearTraceFilters()">Clear</button>
            <span class="muted">{{ filteredTraceItems.length }} / {{ result!.processingTrace!.length }} rows</span>
          </div>
          <div class="col-filters-grid" *ngIf="showTraceColFilters">
            <label *ngFor="let c of traceFilterCols">
              {{ c.label }}
              <input type="text" [(ngModel)]="traceCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
            </label>
          </div>
          <div class="data-table-wrap data-table-scroll">
            <table class="data-table trace-table">
              <thead>
                <tr>
                  <th>Step</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredTraceItems">
                  <td class="cell-tight"><code>{{ item.row.step }}</code></td>
                  <td class="trace-detail"><pre>{{ item.row.detail | json }}</pre></td>
                </tr>
              </tbody>
            </table>
          </div>
        </section>

        <section class="block collapsible">
          <label class="chk raw-toggle">
            <input type="checkbox" [(ngModel)]="showRawJson" />
            Show raw JSON response
          </label>
          <pre *ngIf="showRawJson" class="raw">{{ result | json }}</pre>
        </section>
      </ng-container>

      <p *ngIf="!result && !loading && !error" class="muted">No result yet. Set filters and click Simulate.</p>
    </div>
  `,
  styles: [
    `
      .filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        align-items: flex-end;
        margin-bottom: 12px;
      }
      .filter-row label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 12px;
        font-weight: 600;
        color: #3d4d63;
      }
      .filter-row .hint {
        font-weight: 400;
        font-size: 11px;
        color: #5c6b7e;
      }
      .filter-slice-stats {
        margin: 0 0 12px;
        padding-left: 1.2rem;
        font-size: 0.8125rem;
        line-height: 1.5;
        color: #3d4d63;
      }
      .filter-slice-stats li {
        margin-bottom: 4px;
      }
      .filter-slice-stats code {
        font-size: 0.75rem;
      }
      .unassigned-detail-cell {
        vertical-align: top;
      }
      .unassigned-summary {
        margin-bottom: 6px;
        line-height: 1.45;
      }
      .unassigned-bullets {
        margin: 0;
        padding-left: 1.1rem;
        font-size: 0.8125rem;
        line-height: 1.45;
        color: #334155;
      }
      .unassigned-bullets li {
        margin-bottom: 4px;
      }
      .sel {
        min-width: 9rem;
        padding: 8px;
        border: 1px solid #d0d8e8;
        border-radius: 6px;
        background: #fff;
      }
      .sel.wide {
        min-width: 14rem;
        max-width: 22rem;
      }
      .sim-toolbar {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
        margin-bottom: 12px;
      }
      .chk {
        display: flex;
        align-items: center;
        gap: 6px;
        font-size: 13px;
      }
      .num-in {
        width: 8rem;
      }
      .muted {
        color: #5c6b7e;
      }
      .hint-banner {
        margin: 0 0 14px;
        padding: 12px 14px;
        font-size: 0.8125rem;
        line-height: 1.5;
        color: var(--color-text);
        background: #fffbeb;
        border: 1px solid #fcd34d;
        border-radius: var(--radius-md);
      }
      .hint-banner code {
        font-size: 0.75rem;
      }
      .alert-warn-soft {
        background: #fff7ed;
        border: 1px solid #fdba74;
        border-radius: var(--radius-md);
        padding: 12px 14px;
      }
      .profile-gap-list {
        margin: 10px 0 0;
        padding-left: 1.2rem;
      }
      .profile-gap-list li {
        margin-bottom: 8px;
        font-size: 0.875rem;
        line-height: 1.45;
      }
      .sim-kpi {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-bottom: 16px;
      }
      .kpi {
        background: #f0f4fc;
        border-radius: 8px;
        padding: 10px 14px;
        min-width: 120px;
      }
      .kpi .lbl {
        display: block;
        font-size: 12px;
        color: #5c6b7e;
      }
      .kpi .val {
        font-size: 22px;
        font-weight: 700;
        color: #15358f;
      }
      .block {
        margin-bottom: 20px;
      }
      .block h3 {
        margin: 0 0 8px;
        font-size: 16px;
      }
      .explain {
        margin: 0 0 8px;
        line-height: 1.45;
      }
      .mini-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
        gap: 6px;
        font-size: 13px;
      }
      table.trace-table .trace-detail pre {
        margin: 0;
        font-size: 0.6875rem;
        white-space: pre-wrap;
        word-break: break-word;
        max-width: 48rem;
      }
      .raw {
        background: #1e293b;
        color: #e2e8f0;
        padding: 12px;
        border-radius: 8px;
        overflow: auto;
        max-height: 400px;
        font-size: 12px;
      }
      .raw-toggle {
        margin-bottom: 8px;
      }
      .strategy {
        font-size: 13px;
        line-height: 1.4;
        margin: 0 0 12px;
        padding: 10px 12px;
        background: #eef8ff;
        border-radius: 8px;
        border: 1px solid #cfe8ff;
      }
    `
  ]
})
export class SimulateComponent implements OnInit {
  private readonly api = inject(ApiService);
  payload: Record<string, unknown> = {
    gender: "",
    profile: "",
    discipline: "",
    resetBeforeRun: true,
    includeTrace: true,
    preferSuggestedIc: true,
    ignoreRoleSuitability: false,
    includeUnassignedLog: true,
    phasedPreference: true,
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
  disciplinesLoading = false;
  result: SimulateResponse | null = null;
  error = "";
  loading = false;
  showRawJson = false;

  readonly assignmentFilterCols = ASSIGNMENT_FILTER_COLS;
  readonly unassignedFilterCols = UNASSIGNED_FILTER_COLS;
  readonly traceFilterCols = TRACE_FILTER_COLS;

  assignGlobal = "";
  assignCol: Record<string, string> = {};
  showAssignColFilters = false;

  unassignGlobal = "";
  unassignCol: Record<string, string> = {};
  showUnassignColFilters = false;

  traceGlobal = "";
  traceCol: Record<string, string> = {};
  showTraceColFilters = false;

  /** Legacy two-phase: business rows only (IC names); otherwise full assignment list. */
  get assignmentsForTable(): SimulateAssignment[] {
    const r = this.result;
    if (!r?.assignments?.length) return [];
    if (
      r.legacyTwoPhaseScript &&
      Array.isArray(r.businessAssignments) &&
      r.businessAssignments.length > 0
    ) {
      return r.businessAssignments as SimulateAssignment[];
    }
    return r.assignments;
  }

  get filteredAssignmentItems(): { row: SimulateAssignment; origIndex: number }[] {
    const rows = this.assignmentsForTable;
    return filterRowsIndexed(
      rows,
      ASSIGNMENT_FILTER_COLS as ColumnFilterDef<SimulateAssignment>[],
      this.assignGlobal,
      this.assignCol
    );
  }

  get filteredUnassignedItems(): { row: UnassignedDetail; origIndex: number }[] {
    const rows = this.result?.unassignedDetails ?? [];
    return filterRowsIndexed(
      rows,
      UNASSIGNED_FILTER_COLS as ColumnFilterDef<UnassignedDetail>[],
      this.unassignGlobal,
      this.unassignCol
    );
  }

  get filteredTraceItems(): {
    row: { step: string; detail?: Record<string, unknown> };
    origIndex: number;
  }[] {
    const rows = this.result?.processingTrace ?? [];
    return filterRowsIndexed(
      rows,
      TRACE_FILTER_COLS as ColumnFilterDef<{ step: string; detail?: Record<string, unknown> }>[],
      this.traceGlobal,
      this.traceCol
    );
  }

  clearAssignFilters(): void {
    this.assignGlobal = "";
    this.assignCol = {};
  }

  clearUnassignFilters(): void {
    this.unassignGlobal = "";
    this.unassignCol = {};
  }

  clearTraceFilters(): void {
    this.traceGlobal = "";
    this.traceCol = {};
  }

  exportAssignmentsExcel(): void {
    const items = this.filteredAssignmentItems;
    if (!items.length) return;
    const { headers, dataRows } = buildAssignmentExport(items);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadExcelCsv(headers, dataRows, `simulate-assignments-${stamp}`);
  }

  exportUnassignedExcel(): void {
    const items = this.filteredUnassignedItems;
    if (!items.length) return;
    const { headers, dataRows } = buildUnassignedExport(items);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadExcelCsv(headers, dataRows, `simulate-unassigned-${stamp}`);
  }

  private resetResultTableFilters(): void {
    this.clearAssignFilters();
    this.clearUnassignFilters();
    this.clearTraceFilters();
    this.showAssignColFilters = false;
    this.showUnassignColFilters = false;
    this.showTraceColFilters = false;
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
    this.disciplinesLoading = true;
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
            return;
          }
          this.disciplinesLoading = false;
        },
        error: () => {
          this.disciplinesLoading = false;
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

  simulate(): void {
    this.loading = true;
    this.error = "";
    this.result = null;
    this.resetResultTableFilters();
    this.api.simulate(this.sanitizePayload()).subscribe({
      next: (res) => {
        this.result = res as SimulateResponse;
        this.loading = false;
      },
      error: (e) => {
        this.result = null;
        this.error = e?.error?.error ?? e?.message ?? "Simulation failed";
        this.loading = false;
      }
    });
  }
}
