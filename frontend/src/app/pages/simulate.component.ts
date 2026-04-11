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
import {
  buildAssignmentExport,
  buildFinalAllocationMatchReport,
  buildUnassignedExport,
  downloadExcelCsv
} from "../excel-export.util";
import type { FinalMatchReportRow } from "../final-match-audit.util";
import { FinalMatchReportComponent } from "../components/final-match-report.component";
import { CollapsibleSectionComponent } from "../components/collapsible-section.component";

type SimulateAssignment = {
  requirementId?: number;
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

type UnassignedDetail = {
  candidateId: number;
  email: string;
  meritscore: number;
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
  permanentZone?: string;
  permanentState?: string;
  sameAsP1?: boolean | null;
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

type SimulateResponse = {
  mode?: string;
  assigned?: number;
  unassigned?: number;
  candidatesConsidered?: number;
  requirementsConsidered?: number;
  icGenderSeatReport?: IcGenderSeatReportRow[];
  icGenderSeatReportTotals?: IcGenderSeatReportTotals;
  unassignedIcInsights?: UnassignedIcInsights;
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
};

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgIf, NgFor, DecimalPipe, FinalMatchReportComponent, CollapsibleSectionComponent],
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
        <!-- <li>
          <strong>{{ filterOptions.requirementSlice.requirementRowCount }}</strong> requirement row(s) with open
          capacity (<code>newvalue > 0</code>) for the current gender / profile / discipline filters — same slice a
          <strong>fresh simulate</strong> loads.
        </li> -->
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
          Fresh simulate
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['includeTrace']" />
          Trace
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['preferSuggestedIc']" />
          Panel Prefer suggested IC
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['ignoreRoleSuitability']" />
          Ignore Panel HR role suggested
        </label>
        <!-- <label
          class="chk"
          title="When checked, candidate gender need not match the seat line gender for eligibility or picks. Requirement rows still store line gender in data/logs. Reduces “gender mismatch only” in the unassigned vs open seats report."
        >
          <input type="checkbox" [(ngModel)]="payload['ignoreGender']" />
          Ignore seat-line gender (match profile/discipline/zone/business/HR only)
        </label> -->
        <label
          class="chk"
          title="After the main run with HR enforced, walks remaining open seats again in the same order using only still-unassigned candidates, ignoring HR role vs seat line. Gender, profile, discipline, zone, and business rules stay the same. No effect when “Ignore Panel HR role suggested” is on."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['hrRelaxUnassignedSecondPass']"
            [disabled]="!!payload['ignoreRoleSuitability']"
          />
          2nd pass: unassigned only, ignore HR role
        </label>
        <label
          class="chk"
          title="After primary (and optional HR second pass), walks remaining open seats again in the same order using only still-unassigned candidates, ignoring seat-line gender vs candidate. If the HR second pass ran, pass 3 keeps HR relaxed like pass 2; otherwise HR follows your primary run. No effect when “Ignore seat-line gender” is on."
        >
          <input
            type="checkbox"
            [(ngModel)]="payload['genderRelaxUnassignedThirdPass']"
            [disabled]="!!payload['ignoreGender']"
          />
          3rd pass: unassigned only, ignore seat-line gender
        </label>
        <label class="chk">
          <input type="checkbox" [(ngModel)]="payload['includeUnassignedLog']" />
          Unassigned logs
        </label>
        <label  class="chk" title="P1→P2→P3→NP, each zone N,S,E,W. Uncheck for legacy any-zone match.">
          <input type="checkbox" disabled="true" [(ngModel)]="payload['phasedPreference']" />
          phased P1→P2→P3→NP
        </label>
        <!-- <label
          class="chk"
          title="Match old Node script: zone pass on requirements_zone_calculated, then business on requirements; seq_* with execute=1. Needs that table in MySQL."
        >
          <input type="checkbox" [(ngModel)]="payload['useLegacyTwoPhaseScript']" />
          legacy two-phase script
        </label> -->
        <!-- <input
          type="number"
          min="1"
          class="num-in"
          [(ngModel)]="payload['maxPerIc']"
          placeholder="max per IC"
        /> -->
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
        <p *ngIf="result?.hrRelaxUnassignedSecondPass?.requested" class="hint-banner hr-relax-summary">
          <strong>HR role relax (2nd pass):</strong>
          <span *ngIf="result?.hrRelaxUnassignedSecondPass?.skipReason === 'primary_run_already_ignores_hr'">
            Not run — primary already ignores HR role rules.
          </span>
          <span *ngIf="result?.hrRelaxUnassignedSecondPass?.executed">
            Filled <strong>{{ result?.hrRelaxUnassignedSecondPass?.assignmentsAdded }}</strong> extra seat(s) from the
            still-unassigned pool (HR role line ignored). Second-pass skips: no candidate
            {{ result?.hrRelaxUnassignedSecondPass?.secondPassSkippedNoCandidate }}, IC cap
            {{ result?.hrRelaxUnassignedSecondPass?.secondPassSkippedDueToIcCap }}.
          </span>
        </p>
        <p *ngIf="result?.genderRelaxUnassignedThirdPass?.requested" class="hint-banner hr-relax-summary">
          <strong>HR gender relax (3rd pass):</strong>
          <span *ngIf="result?.genderRelaxUnassignedThirdPass?.skipReason === 'primary_run_already_ignores_gender'">
            Not run — primary already ignores seat-line gender.
          </span>
          <span *ngIf="result?.genderRelaxUnassignedThirdPass?.executed">
            Filled <strong>{{ result?.genderRelaxUnassignedThirdPass?.assignmentsAdded }}</strong> extra seat(s) from the
            still-unassigned pool (seat-line gender ignored). Third-pass skips: no candidate
            {{ result?.genderRelaxUnassignedThirdPass?.thirdPassSkippedNoCandidate }}, IC cap
            {{ result?.genderRelaxUnassignedThirdPass?.thirdPassSkippedDueToIcCap }}.
          </span>
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
          <!-- <div class="kpi">
            <span class="lbl">Req. rows</span><span class="val">{{ result!.requirementsConsidered ?? "—" }}</span>
          </div> -->
        </div>

        <app-collapsible-section
          *ngIf="result?.icGenderSeatReport?.length"
          title="IC seat summary (this run)"
          sectionClass="block ic-report-section"
          [startOpen]="false"
        >
          <p class="page-desc ic-report-intro">
            Counts are by <strong>seat line</strong> gender on each requirement row. <strong>Filled</strong> = seats
            assigned in this run; <strong>pending</strong> = seats still open on those rows after the run.
          </p>
          <div class="data-table-wrap ic-report-wrap">
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
                <tr *ngFor="let row of result!.icGenderSeatReport!">
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
              <tfoot *ngIf="result?.icGenderSeatReportTotals as tot">
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

        <ng-container *ngIf="result?.unassignedIcInsights as uii">
          <app-collapsible-section
            title="Unassigned vs open seats (by IC)"
            sectionClass="block unassigned-insight-section"
            [startOpen]="false"
          >
          <p class="page-desc insight-intro">
            <strong>{{ uii.unassignedCount }}</strong> unassigned candidate(s) in this run. Where an IC still has open
            seats, the table explains mismatches vs those lines (each person at most once per IC; they can appear on
            several ICs).
          </p>
          <p class="muted insight-footnote">{{ uii.note }}</p>
          <div *ngIf="!uii.rows?.length" class="muted insight-empty">No IC with open seats in this slice — nothing to
            cross-check per IC.</div>
          <div class="data-table-wrap insight-table-wrap" *ngIf="uii.rows?.length">
            <table class="data-table insight-table">
              <thead>
                <tr>
                  <th scope="col" class="insight-sticky">IC</th>
                  <th scope="col" class="insight-num" title="Open seats left on this IC after the run">Open seats</th>
                  <th scope="col" class="insight-num" title="Could sit here under current rules; did not get a seat (merit / order / caps)">Eligible, no seat</th>
                  <th scope="col" class="insight-num" title="Only seat gender blocks vs an open line">Gender mismatch</th>
                  <th scope="col" class="insight-num" title="Only HR role blocks">HR role mismatch</th>
                  <th scope="col" class="insight-num" title="Profile/discipline/HR/gender OK but zone or business vs seat line">Zone / business</th>
                  <th scope="col" class="insight-num" title="No open line at this IC shares profile + discipline">No P+D line</th>
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

        <ng-container *ngIf="result?.reconciliation as rec">
          <app-collapsible-section
            title="Requirement vs assignment reconciliation"
            sectionClass="block"
            [startOpen]="false"
          >
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
            <!-- <div>Filled + open = loaded: <strong>{{ rec["capacityEquationHolds"] ? "Yes" : "No" }}</strong></div> -->
            <!-- <div>Skipped (no eligible candidate): <strong>{{ rec["slotsSkippedNoEligibleCandidate"] }}</strong></div> -->
            <!-- <div>Skipped (IC cap): <strong>{{ rec["slotsSkippedDueToIcCap"] }}</strong></div> -->
            <!-- <div>Pool shape: <strong>{{ rec["allocationShape"] }}</strong></div> -->
          </div>
          <p class="page-desc" style="margin-top: 10px;">{{ rec["exportHint"] }}</p>
          <pre
            *ngIf="rec['verifyAgainstDbSql']"
            class="sql-hint"
            style="white-space: pre-wrap; font-size: 0.85rem; background: var(--panel-2, #f5f5f5); padding: 10px; border-radius: 6px;"
            >{{ rec["verifyAgainstDbSql"] }}</pre
          >
          </app-collapsible-section>
        </ng-container>

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

        <app-collapsible-section
          *ngIf="result?.unassignedSummary"
          title="Why some are unassigned"
          sectionClass="block"
          [startOpen]="false"
        >
          <p class="explain">{{ result?.unassignedSummary?.explanation }}</p>
          <div class="mini-grid">
            <div>Never eligible (no row match): <strong>{{ result?.unassignedSummary?.neverEligibleForAnyRequirement }}</strong></div>
            <div>Eligible but no seat / outranked: <strong>{{ result?.unassignedSummary?.eligibleButNotAssigned }}</strong></div>
            <div>Total seats this run: <strong>{{ result?.unassignedSummary?.totalSlotsInRun }}</strong></div>
            <div>Slots skipped (no candidate): <strong>{{ result?.unassignedSummary?.skippedSlotsNoCandidate }}</strong></div>
            <!-- <div>Slots skipped (IC cap): <strong>{{ result?.unassignedSummary?.skippedSlotsDueToIcCap }}</strong></div> -->
          </div>
        </app-collapsible-section>

        <app-collapsible-section
          *ngIf="result!.assignments?.length"
          [title]="assignmentSectionTitle"
          sectionClass="block"
          [startOpen]="true"
        >
          <p class="page-desc" style="margin: 4px 0 10px;">
            Filter rows to cross-check against another script. Search matches any column; column filters must all match (case-insensitive contains).
            Both <strong>Export Excel</strong> buttons download UTF-8 CSV files that open in Excel. The first is the wide
            assignment grid; the second is the <strong>final match report</strong> (Req* columns + Bus./Zone/HR checks).
            The <strong>on-screen final match report</strong> below uses the same rows with green highlights and match flags.
          </p>
          <app-final-match-report *ngIf="result!.assignments?.length" [rows]="finalMatchRows" />
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
            <button
              type="button"
              class="btn btn-primary"
              style="margin-left: 8px"
              (click)="exportFinalMatchReportExcel()"
            >
              Export Excel — final match report
            </button>
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
                <tr *ngFor="let item of filteredAssignmentItems">
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
                  <td class="cell-tight">{{ item.row.candidateId }}</td>
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

        <app-collapsible-section
          *ngIf="result!.unassignedDetails?.length"
          [title]="unassignedDetailSectionTitle"
          sectionClass="block"
          [startOpen]="false"
        >
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
                  <th>Failure Reason Code</th>
                  <th>Failure Reason Detail</th>
                  <th>Complete</th>
                  <th>Combination-Key1</th>
                  <th>Batch</th>
                  <th>Combination-Key2 (Allocated)</th>
                  <th>Permanent State</th>
                  <th>Permanent Zone</th>
                  <th>Same as P1</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredUnassignedItems">
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
                  <td class="cell-tight">—</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-clip" [attr.title]="item.row.discipline ?? ''">{{ item.row.discipline || "—" }}</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-wide unassigned-detail-cell">
                    <div class="unassigned-summary"><code>{{ item.row.reasonCode }}</code> — {{ item.row.detail }}</div>
                    <ul *ngIf="item.row.detailBullets?.length" class="unassigned-bullets">
                      <li *ngFor="let b of item.row.detailBullets">{{ b }}</li>
                    </ul>
                  </td>
                  <td class="cell-tight">{{ item.row.candidateId }}</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-tight">NOT_ASSIGNED</td>
                  <td class="cell-tight"><code>{{ item.row.reasonCode }}</code></td>
                  <td class="cell-wide">{{ item.row.detail }}</td>
                  <td class="cell-tight">No</td>
                  <td class="cell-wide">{{ (item.row.profile || "—") + "|" + (item.row.discipline || "—") + "|" + (item.row.gender || "—") + "|—" }}</td>
                  <td class="cell-tight">—</td>
                  <td class="cell-wide">—</td>
                  <td class="cell-tight">{{ item.row.permanentState || "—" }}</td>
                  <td class="cell-tight">{{ item.row.permanentZone || "—" }}</td>
                  <td class="cell-tight">{{ item.row.sameAsP1 == null ? "—" : item.row.sameAsP1 ? "true" : "false" }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </app-collapsible-section>

        <app-collapsible-section
          *ngIf="result!.processingTrace?.length"
          [title]="traceSectionTitle"
          sectionClass="block"
          [startOpen]="false"
        >
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
        </app-collapsible-section>

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
      .ic-report-section {
        background: linear-gradient(180deg, #f8fafc 0%, #fff 48%);
        border: 1px solid #e2e8f0;
        border-radius: 10px;
        padding: 14px 16px 16px;
      }
      .ic-report-section .cs-toggle {
        margin-bottom: 8px;
        background: rgba(255, 255, 255, 0.75);
        border-color: #cbd5e1;
      }
      .ic-report-intro {
        margin: 0 0 12px;
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
        text-transform: none;
        letter-spacing: 0.02em;
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
        margin-top: 4px;
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
        max-width: 56rem;
      }
      .insight-footnote {
        margin: 0 0 12px;
        font-size: 0.78rem;
        line-height: 1.45;
        max-width: 56rem;
      }
      .insight-empty {
        margin: 0 0 10px;
        font-size: 0.875rem;
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
        vertical-align: bottom;
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
    preferSuggestedIc: false,
    ignoreRoleSuitability: true,
    ignoreGender: false,
    hrRelaxUnassignedSecondPass: false,
    genderRelaxUnassignedThirdPass: false,
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

  get assignmentSectionTitle(): string {
    return `Assignments (${this.assignmentsForTable.length} shown)`;
  }

  get unassignedDetailSectionTitle(): string {
    const n = this.result?.unassignedDetails?.length ?? 0;
    return `Unassigned detail (${n} shown)`;
  }

  get traceSectionTitle(): string {
    const n = this.result?.processingTrace?.length ?? 0;
    return `Processing steps (${n})`;
  }

  get finalMatchRows(): FinalMatchReportRow[] {
    return this.filteredAssignmentItems.map((i) => i.row as FinalMatchReportRow);
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

  /** Requirement vs candidate zones/businesses/roles vs allocation (same visible rows as table filters). */
  exportFinalMatchReportExcel(): void {
    const items = this.filteredAssignmentItems;
    if (!items.length) return;
    const { headers, dataRows } = buildFinalAllocationMatchReport(items);
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "");
    downloadExcelCsv(headers, dataRows, `simulate-final-match-excel-${stamp}`);
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
