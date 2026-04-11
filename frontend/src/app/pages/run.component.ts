import { Component, inject, OnInit } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DecimalPipe, JsonPipe, NgFor, NgIf } from "@angular/common";
import { ApiService, type AllocationFilterOptions } from "../api.service";
import { ASSIGNMENT_FILTER_COLS, filterRowsIndexed, type ColumnFilterDef } from "../table-filter.util";
import { buildAssignmentExport, buildFinalAllocationMatchReport, downloadExcelCsv } from "../excel-export.util";
import type { FinalMatchReportRow } from "../final-match-audit.util";
import { FinalMatchReportComponent } from "../components/final-match-report.component";
import { CollapsibleSectionComponent } from "../components/collapsible-section.component";

type RunAssignment = {
  requirementId?: number;
  candidateId?: number;
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
  requirementRoleName?: string | null;
  servicePreferences?: string;
  roleSuitability?: string;
  preferencePhase?: string;
  candidateSuitable?: string | null;
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
  permanentZone?: string;
  permanentState?: string;
  sameAsP1?: boolean | null;
  hrRelaxedSecondPass?: boolean;
  requirementGender?: string;
  genderRelaxedThirdPass?: boolean;
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

type IcGenderSeatReportRow = {
  icname: string;
  maleFilled: number;
  femaleFilled: number;
  otherFilled: number;
  malePending: number;
  femalePending: number;
  otherPending: number;
  totalFilled: number;
  totalPending: number;
};

type IcGenderSeatReportTotals = {
  maleFilled: number;
  femaleFilled: number;
  otherFilled: number;
  malePending: number;
  femalePending: number;
  otherPending: number;
  totalFilled: number;
  totalPending: number;
};

type UnassignedIcInsightRow = {
  icname: string;
  openSeatsPending: number;
  strictEligibleUnassigned: number;
  blockedGenderMismatchOnly: number;
  blockedHrRoleMismatchOnly: number;
  blockedZoneOrBusinessMismatch: number;
  profileDisciplineNoMatchingSeatLineAtIc: number;
  otherAtIc: number;
};

type UnassignedIcInsights = {
  unassignedCount: number;
  note: string;
  rows: UnassignedIcInsightRow[];
  totals: {
    openSeatsPending: number;
    strictEligibleUnassigned: number;
    blockedGenderMismatchOnly: number;
    blockedHrRoleMismatchOnly: number;
    blockedZoneOrBusinessMismatch: number;
    profileDisciplineNoMatchingSeatLineAtIc: number;
    otherAtIc: number;
  };
};

type RunResult = {
  mode?: string;
  assigned?: number;
  unassigned?: number;
  candidatesConsidered?: number;
  requirementsConsidered?: number;
  icGenderSeatReport?: IcGenderSeatReportRow[];
  icGenderSeatReportTotals?: IcGenderSeatReportTotals;
  unassignedIcInsights?: UnassignedIcInsights;
  assignments?: RunAssignment[];
  legacyTwoPhaseScript?: boolean;
  businessAssignments?: RunAssignment[];
  zoneAssignments?: RunAssignment[];
  unassignedSummary?: UnassignedSummary;
  /** Present for legacy two-phase runs. */
  allocationStrategy?: { mode?: string; order?: string };
  profilesMissingRequirements?: Array<{ profile: string; candidateCount: number; message: string }>;
  hrRelaxUnassignedSecondPass?: {
    requested: boolean;
    executed: boolean;
    skipReason?: "primary_run_already_ignores_hr";
    assignmentsAdded: number;
    secondPassSkippedNoCandidate: number;
    secondPassSkippedDueToIcCap: number;
  };
  genderRelaxUnassignedThirdPass?: {
    requested: boolean;
    executed: boolean;
    skipReason?: "primary_run_already_ignores_gender";
    assignmentsAdded: number;
    thirdPassSkippedNoCandidate: number;
    thirdPassSkippedDueToIcCap: number;
  };
  error?: string;
};

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgFor, NgIf, DecimalPipe, FinalMatchReportComponent, CollapsibleSectionComponent],
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
          title="Candidate gender need not match seat-line gender. Not supported for legacy two-phase script. Seat rows still record line gender in the database."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['ignoreGender']"
            [disabled]="!!payload['useLegacyTwoPhaseScript']"
          />
          Ignore seat-line gender
        </label>
        <label
          class="form-check"
          title="After the main run with HR enforced, fills remaining seats from the unassigned pool only, ignoring HR role vs seat line. Unavailable when legacy two-phase script is on or when primary already ignores HR."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['hrRelaxUnassignedSecondPass']"
            [disabled]="!!payload['useLegacyTwoPhaseScript'] || !!payload['ignoreRoleSuitability']"
          />
          2nd pass: unassigned only, ignore HR role
        </label>
        <label
          class="form-check"
          title="After primary (and optional HR second pass), fills remaining seats from the unassigned pool only, ignoring seat-line gender. If HR second pass ran, pass 3 keeps HR relaxed like pass 2; otherwise HR follows primary. Disabled when legacy script is on or when primary already ignores seat-line gender."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['genderRelaxUnassignedThirdPass']"
            [disabled]="!!payload['useLegacyTwoPhaseScript'] || !!payload['ignoreGender']"
          />
          3rd pass: unassigned only, ignore seat-line gender
        </label>
        <label
          class="form-check"
          title="EduTech flow: P1→P2→P3→NP, each zone N,S,E,W. Uncheck for legacy any-zone match. Disabled when legacy two-phase script is on."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['phasedPreference']"
            [disabled]="payload['useLegacyTwoPhaseScript']"
          />
          Phased P1→P2→P3→NP
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
        <p *ngIf="r.hrRelaxUnassignedSecondPass?.requested" class="strategy-banner hr-relax-run-summary">
          <strong>HR role relax (2nd pass):</strong>
          <span *ngIf="r.hrRelaxUnassignedSecondPass?.skipReason === 'primary_run_already_ignores_hr'">
            Not run — primary already ignores HR role rules.
          </span>
          <span *ngIf="r.hrRelaxUnassignedSecondPass?.executed">
            Filled <strong>{{ r.hrRelaxUnassignedSecondPass?.assignmentsAdded }}</strong> extra seat(s). Second-pass
            skips: no candidate {{ r.hrRelaxUnassignedSecondPass?.secondPassSkippedNoCandidate }}, IC cap
            {{ r.hrRelaxUnassignedSecondPass?.secondPassSkippedDueToIcCap }}.
          </span>
        </p>
        <p *ngIf="r.genderRelaxUnassignedThirdPass?.requested" class="strategy-banner hr-relax-run-summary">
          <strong>HR gender relax (3rd pass):</strong>
          <span *ngIf="r.genderRelaxUnassignedThirdPass?.skipReason === 'primary_run_already_ignores_gender'">
            Not run — primary already ignores seat-line gender.
          </span>
          <span *ngIf="r.genderRelaxUnassignedThirdPass?.executed">
            Filled <strong>{{ r.genderRelaxUnassignedThirdPass?.assignmentsAdded }}</strong> extra seat(s). Third-pass
            skips: no candidate {{ r.genderRelaxUnassignedThirdPass?.thirdPassSkippedNoCandidate }}, IC cap
            {{ r.genderRelaxUnassignedThirdPass?.thirdPassSkippedDueToIcCap }}.
          </span>
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

        <app-collapsible-section
          *ngIf="r.icGenderSeatReport?.length"
          title="IC seat summary (this run)"
          sectionClass="ic-report-section"
          [startOpen]="false"
        >
          <p class="ic-report-intro">
            By <strong>seat line</strong> gender on each requirement row. Filled = assigned this run; pending = still
            open on those rows.
          </p>
          <div class="ic-report-wrap">
            <table class="data-table ic-report-table">
              <thead>
                <tr>
                  <th scope="col" class="ic-report-sticky">IC</th>
                  <th scope="col" class="ic-num">Male filled</th>
                  <th scope="col" class="ic-num">Male pending</th>
                  <th scope="col" class="ic-num">Female filled</th>
                  <th scope="col" class="ic-num">Female pending</th>
                  <th scope="col" class="ic-num">Other filled</th>
                  <th scope="col" class="ic-num">Other pending</th>
                  <th scope="col" class="ic-num">Total filled</th>
                  <th scope="col" class="ic-num">Total pending</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let row of r.icGenderSeatReport!">
                  <th scope="row" class="ic-report-sticky cell-clip" [attr.title]="row.icname">{{ row.icname }}</th>
                  <td class="ic-num">{{ row.maleFilled }}</td>
                  <td class="ic-num">{{ row.malePending }}</td>
                  <td class="ic-num">{{ row.femaleFilled }}</td>
                  <td class="ic-num">{{ row.femalePending }}</td>
                  <td class="ic-num">{{ row.otherFilled }}</td>
                  <td class="ic-num">{{ row.otherPending }}</td>
                  <td class="ic-num ic-strong">{{ row.totalFilled }}</td>
                  <td class="ic-num ic-strong">{{ row.totalPending }}</td>
                </tr>
              </tbody>
              <tfoot *ngIf="r.icGenderSeatReportTotals as tot">
                <tr class="ic-report-total-row">
                  <th scope="row">All ICs</th>
                  <td class="ic-num">{{ tot.maleFilled }}</td>
                  <td class="ic-num">{{ tot.malePending }}</td>
                  <td class="ic-num">{{ tot.femaleFilled }}</td>
                  <td class="ic-num">{{ tot.femalePending }}</td>
                  <td class="ic-num">{{ tot.otherFilled }}</td>
                  <td class="ic-num">{{ tot.otherPending }}</td>
                  <td class="ic-num ic-strong">{{ tot.totalFilled }}</td>
                  <td class="ic-num ic-strong">{{ tot.totalPending }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </app-collapsible-section>

        <ng-container *ngIf="r.unassignedIcInsights as uii">
          <app-collapsible-section
            title="Unassigned vs open seats (by IC)"
            sectionClass="unassigned-insight-section"
            [startOpen]="false"
          >
          <p class="insight-intro">
            <strong>{{ uii.unassignedCount }}</strong> unassigned candidate(s). Counts are per IC with open seats;
            each person at most once per IC.
          </p>
          <p class="insight-footnote">{{ uii.note }}</p>
          <p *ngIf="!uii.rows?.length" class="insight-empty">No IC with open seats in this slice.</p>
          <div class="insight-table-wrap" *ngIf="uii.rows?.length">
            <table class="data-table insight-table">
              <thead>
                <tr>
                  <th scope="col" class="insight-sticky">IC</th>
                  <th scope="col" class="insight-num">Open seats</th>
                  <th scope="col" class="insight-num">Eligible, no seat</th>
                  <th scope="col" class="insight-num">Gender mismatch</th>
                  <th scope="col" class="insight-num">HR role mismatch</th>
                  <th scope="col" class="insight-num">Zone / business</th>
                  <th scope="col" class="insight-num">No P+D line</th>
                  <th scope="col" class="insight-num">Other</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let ir of uii.rows">
                  <th scope="row" class="insight-sticky cell-clip" [attr.title]="ir.icname">{{ ir.icname }}</th>
                  <td class="insight-num">{{ ir.openSeatsPending }}</td>
                  <td class="insight-num">{{ ir.strictEligibleUnassigned }}</td>
                  <td class="insight-num">{{ ir.blockedGenderMismatchOnly }}</td>
                  <td class="insight-num">{{ ir.blockedHrRoleMismatchOnly }}</td>
                  <td class="insight-num">{{ ir.blockedZoneOrBusinessMismatch }}</td>
                  <td class="insight-num">{{ ir.profileDisciplineNoMatchingSeatLineAtIc }}</td>
                  <td class="insight-num">{{ ir.otherAtIc }}</td>
                </tr>
              </tbody>
              <tfoot *ngIf="uii.totals as itot">
                <tr class="insight-total-row">
                  <th scope="row">Totals (sum over ICs)</th>
                  <td class="insight-num">{{ itot.openSeatsPending }}</td>
                  <td class="insight-num">{{ itot.strictEligibleUnassigned }}</td>
                  <td class="insight-num">{{ itot.blockedGenderMismatchOnly }}</td>
                  <td class="insight-num">{{ itot.blockedHrRoleMismatchOnly }}</td>
                  <td class="insight-num">{{ itot.blockedZoneOrBusinessMismatch }}</td>
                  <td class="insight-num">{{ itot.profileDisciplineNoMatchingSeatLineAtIc }}</td>
                  <td class="insight-num">{{ itot.otherAtIc }}</td>
                </tr>
              </tfoot>
            </table>
          </div>
          </app-collapsible-section>
        </ng-container>

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

        <app-collapsible-section
          *ngIf="r.unassignedSummary"
          title="Unassigned summary"
          sectionClass="run-collapse-section"
          [startOpen]="false"
        >
          <p class="page-desc" style="margin-top: 6px;">{{ r.unassignedSummary.explanation }}</p>
          <div class="mini-grid">
            <div>Never eligible: <strong>{{ r.unassignedSummary.neverEligibleForAnyRequirement }}</strong></div>
            <div>Eligible, no seat: <strong>{{ r.unassignedSummary.eligibleButNotAssigned }}</strong></div>
            <div>Total seats: <strong>{{ r.unassignedSummary.totalSlotsInRun }}</strong></div>
            <div>Skipped (no candidate): <strong>{{ r.unassignedSummary.skippedSlotsNoCandidate }}</strong></div>
            <div>Skipped (IC cap): <strong>{{ r.unassignedSummary.skippedSlotsDueToIcCap }}</strong></div>
          </div>
        </app-collapsible-section>

        <p *ngIf="r.legacyTwoPhaseScript" class="page-desc" style="margin-top: 12px;">
          Legacy two-phase: table shows <strong>business</strong> rows (IC names) when present;
          zone-only steps are in <code>zoneAssignments</code> in raw JSON.
        </p>

        <app-collapsible-section
          *ngIf="r.assignments?.length"
          [title]="runAssignmentSectionTitle"
          sectionClass="run-assignments-collapse"
          [startOpen]="true"
        >
          <p class="page-desc" style="margin: 4px 0 10px;">
            Search any column or use per-column filters to compare with another script’s output.
            Both <strong>Export Excel</strong> buttons save UTF-8 CSV for Excel. The first is the assignment grid; the
            second is the <strong>final match report</strong> (Requirement IC, Req profile/zone/business/role, candidate
            prefs, allocated IC/zone/role, and Y/N checks). The on-screen table below matches that report.
          </p>
          <app-final-match-report [rows]="finalMatchRows" />
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
            <button
              type="button"
              class="btn btn-primary"
              style="margin-left: 8px"
              (click)="exportFinalMatchReportExcel()"
            >
              Export Excel — final match report
            </button>
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
                  <th>Email Ids</th>
                  <th>Requirement_Discipline</th>
                  <th>Profile</th>
                  <th>Gender</th>
                  <th>candidate_suitable</th>
                  <th>suggested_ic</th>
                  <th>Zone1</th>
                  <th>Zone2</th>
                  <th>Zone3</th>
                  <th>Business1</th>
                  <th>Business2</th>
                  <th>Business3</th>
                  <th>Merit</th>
                  <th>Allocated IC</th>
                  <th>Allocation Zone</th>
                  <th>Allocation Role Name</th>
                  <th>Student Discipline</th>
                  <th>Candidate Name</th>
                  <th>Logs (Allocation Priority ---- Requirement Mapped)</th>
                  <th>Candidate ID</th>
                  <th>Requirement Row ID</th>
                  <th>Eligibility Verdict</th>
                  <th>Zone Match Basis</th>
                  <th>Business Match Basis</th>
                  <th>Eligible Pool Size</th>
                  <th>Rank in Eligible Pool</th>
                  <th>Top Eligible Candidate</th>
                  <th>Remaining Before</th>
                  <th>Remaining After</th>
                  <th>Complete</th>
                  <th>Combination-Key1</th>
                  <th>Batch</th>
                  <th>Combination-Key2 (Allocated)</th>
                  <th>Permanent State</th>
                  <th>Permanent Zone</th>
                  <th>Same as P1</th>
                  <th>HR role relax (2nd)</th>
                  <th>HR gender relax (3rd)</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredRunAssignmentItems">
                  <td class="cell-clip" [attr.title]="item.row.email">{{ item.row.email }}</td>
                  <td class="cell-clip" [attr.title]="item.row.discipline ?? ''">{{ item.row.discipline || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.profile ?? ''">{{ item.row.profile || "—" }}</td>
                  <td class="cell-tight">{{ item.row.gender || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.candidateSuitable ?? ''">
                    {{ item.row.candidateSuitable || "—" }}
                  </td>
                  <td class="cell-clip" [attr.title]="item.row.suggestedIc ?? ''">
                    {{ item.row.suggestedIc || "—" }}
                  </td>
                  <td class="cell-tight">{{ item.row.zone1 || "—" }}</td>
                  <td class="cell-tight">{{ item.row.zone2 || "—" }}</td>
                  <td class="cell-tight">{{ item.row.zone3 || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.business1 ?? ''">{{ item.row.business1 || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.business2 ?? ''">{{ item.row.business2 || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.business3 ?? ''">{{ item.row.business3 || "—" }}</td>
                  <td class="cell-num">{{ item.row.meritscore | number : "1.2-2" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.icname">{{ item.row.icname || "—" }}</td>
                  <td class="cell-tight">{{ item.row.zone || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.requirementRoleName ?? ''">{{ item.row.requirementRoleName || "—" }}</td>
                  <td class="cell-clip" [attr.title]="item.row.discipline ?? ''">{{ item.row.discipline || "—" }}</td>
                  <td class="cell-clip">—</td>
                  <td class="cell-wide">
                    {{ (item.row.preferencePhase || "ANY") + " ---- " + ((item.row.zone || "—") + " / " + (item.row.business || "—") + " / " + (item.row.icname || "—")) }}
                  </td>
                  <td class="cell-tight">{{ item.row.candidateId ?? "—" }}</td>
                  <td class="cell-tight">{{ item.row.requirementId ?? "—" }}</td>
                  <td class="cell-tight">{{ item.row.eligibilityVerdict || "MATCHED" }}</td>
                  <td class="cell-tight">{{ item.row.zoneMatchBasis || "—" }}</td>
                  <td class="cell-tight">{{ item.row.businessMatchBasis || "—" }}</td>
                  <td class="cell-tight">{{ item.row.eligiblePoolSize ?? "—" }}</td>
                  <td class="cell-tight">{{ item.row.eligibleRank ?? "—" }}</td>
                  <td class="cell-clip">{{ (item.row.topEligibleCandidateId ?? "—") + " / " + (item.row.topEligibleCandidateEmail || "—") }}</td>
                  <td class="cell-tight">{{ item.row.requirementRemainingBefore ?? "—" }}</td>
                  <td class="cell-tight">{{ item.row.requirementRemainingAfter ?? "—" }}</td>
                  <td class="cell-tight">Yes</td>
                  <td class="cell-wide">{{ (item.row.profile || "—") + "|" + (item.row.discipline || "—") + "|" + (item.row.gender || "—") + "|" + (item.row.requirementRoleName || "—") }}</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-wide">{{ (item.row.zone || "—") + "|" + (item.row.business || "—") + "|" + (item.row.icname || "—") + "|" + (item.row.requirementRoleName || "—") }}</td>
                  <td class="cell-tight">{{ item.row.permanentState || "—" }}</td>
                  <td class="cell-tight">{{ item.row.permanentZone || "—" }}</td>
                  <td class="cell-tight">{{ item.row.sameAsP1 == null ? "—" : item.row.sameAsP1 ? "true" : "false" }}</td>
                  <td class="cell-tight">{{ item.row.hrRelaxedSecondPass ? "Yes" : "" }}</td>
                  <td class="cell-tight">{{ item.row.genderRelaxedThirdPass ? "Yes" : "" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </app-collapsible-section>
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
      .ic-report-section {
        margin-top: 22px;
        padding: 14px 16px 16px;
        background: linear-gradient(180deg, #f8fafc 0%, #fff 48%);
        border: 1px solid #e2e8f0;
        border-radius: 10px;
      }
      .ic-report-section .cs-toggle {
        margin-bottom: 8px;
        background: rgba(255, 255, 255, 0.75);
        border-color: #cbd5e1;
      }
      .run-collapse-section,
      .run-assignments-collapse {
        margin-top: 24px;
      }
      .run-assignments-collapse .cs-toggle {
        font-size: 1rem;
      }
      .ic-report-intro {
        margin: 0 0 12px;
        font-size: 0.875rem;
        line-height: 1.45;
        color: #475569;
        max-width: 52rem;
      }
      .ic-report-wrap {
        border-radius: 8px;
        border: 1px solid #cbd5e1;
        overflow: auto;
        max-height: min(70vh, 28rem);
        background: #fff;
      }
      .ic-report-table {
        margin: 0;
        min-width: 720px;
      }
      .ic-report-table thead th {
        background: #1e3a5f;
        color: #f8fafc;
        font-weight: 600;
        font-size: 0.75rem;
        border-color: #334155;
        white-space: nowrap;
      }
      .ic-report-table tbody tr:nth-child(even) {
        background: #f8fafc;
      }
      .ic-report-table tbody tr:nth-child(odd) .ic-report-sticky {
        background: #fff;
      }
      .ic-report-table tbody tr:nth-child(even) .ic-report-sticky {
        background: #f8fafc;
      }
      .ic-report-table tbody tr:hover {
        background: #e0f2fe;
      }
      .ic-report-table tbody tr:hover .ic-report-sticky {
        background: #e0f2fe;
      }
      .ic-report-sticky {
        position: sticky;
        left: 0;
        z-index: 1;
        box-shadow: 4px 0 8px -4px rgba(15, 23, 42, 0.15);
        text-align: left;
        min-width: 8rem;
        max-width: 14rem;
      }
      .ic-report-table thead .ic-report-sticky {
        background: #1e3a5f;
        z-index: 2;
      }
      .ic-num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .ic-strong {
        font-weight: 700;
        color: #0c4a6e;
      }
      .ic-report-total-row th,
      .ic-report-total-row td {
        background: #e2e8f0;
        font-weight: 700;
        border-top: 2px solid #94a3b8;
        padding-top: 10px;
        padding-bottom: 10px;
      }
      .ic-report-total-row th {
        text-align: left;
      }
      .unassigned-insight-section {
        margin-top: 22px;
        padding: 14px 16px 16px;
        background: #fffbeb;
        border: 1px solid #fcd34d;
        border-radius: 10px;
      }
      .unassigned-insight-section .cs-toggle {
        margin-bottom: 8px;
        color: #78350f;
        background: #fffbeb;
        border-color: #fcd34d;
      }
      .insight-intro {
        margin: 0 0 6px;
        font-size: 0.875rem;
        line-height: 1.45;
        color: #451a03;
        max-width: 56rem;
      }
      .insight-footnote {
        margin: 0 0 12px;
        font-size: 0.78rem;
        line-height: 1.45;
        color: #92400e;
        max-width: 56rem;
      }
      .insight-empty {
        margin: 0 0 10px;
        font-size: 0.875rem;
        color: #92400e;
      }
      .insight-table-wrap {
        border-radius: 8px;
        border: 1px solid #e2e8f0;
        overflow: auto;
        max-height: min(72vh, 30rem);
        background: #fff;
      }
      .insight-table {
        margin: 0;
        min-width: 880px;
      }
      .insight-table thead th {
        background: #92400e;
        color: #fffbeb;
        font-size: 0.72rem;
        font-weight: 600;
        line-height: 1.25;
        border-color: #b45309;
      }
      .insight-table tbody tr:nth-child(even) {
        background: #fffbeb;
      }
      .insight-table tbody tr:hover {
        background: #fef3c7;
      }
      .insight-sticky {
        position: sticky;
        left: 0;
        z-index: 1;
        min-width: 7rem;
        max-width: 13rem;
        box-shadow: 4px 0 8px -4px rgba(120, 53, 15, 0.12);
      }
      .insight-table thead .insight-sticky {
        background: #92400e;
        z-index: 2;
      }
      .insight-table tbody tr:nth-child(odd) .insight-sticky {
        background: #fff;
      }
      .insight-table tbody tr:nth-child(even) .insight-sticky {
        background: #fffbeb;
      }
      .insight-table tbody tr:hover .insight-sticky {
        background: #fef3c7;
      }
      .insight-num {
        text-align: right;
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
        min-width: 3.25rem;
      }
      .insight-total-row th,
      .insight-total-row td {
        background: #fde68a;
        font-weight: 700;
        border-top: 2px solid #d97706;
        color: #451a03;
      }
      .insight-total-row th {
        text-align: left;
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
    preferSuggestedIc: false,
    ignoreRoleSuitability: true,
    ignoreGender: false,
    hrRelaxUnassignedSecondPass: false,
    genderRelaxUnassignedThirdPass: false,
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
  result: unknown;
  loading = false;
  showRaw = false;

  readonly runAssignmentFilterCols = ASSIGNMENT_FILTER_COLS;
  runAssignGlobal = "";
  runAssignCol: Record<string, string> = {};
  showRunAssignColFilters = false;

  get runAssignmentSectionTitle(): string {
    return `Assignments (${this.runAssignmentsForTable.length} shown)`;
  }

  get finalMatchRows(): FinalMatchReportRow[] {
    return this.filteredRunAssignmentItems.map((i) => i.row as FinalMatchReportRow);
  }

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

  exportFinalMatchReportExcel(): void {
    const items = this.filteredRunAssignmentItems;
    if (!items.length) return;
    const { headers, dataRows } = buildFinalAllocationMatchReport(items);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadExcelCsv(headers, dataRows, `run-final-match-excel-${stamp}`);
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
