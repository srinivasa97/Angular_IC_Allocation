import { Component, Input } from "@angular/core";
import { DecimalPipe, NgFor, NgIf } from "@angular/common";
import {
  auditFinalMatchRow,
  type FinalMatchAudit,
  type FinalMatchReportRow
} from "../final-match-audit.util";

export type { FinalMatchReportRow } from "../final-match-audit.util";

@Component({
  selector: "app-final-match-report",
  standalone: true,
  imports: [NgFor, NgIf, DecimalPipe],
  template: `
    <div class="fmr-wrap">
      <div class="fmr-head">
        <h3 class="fmr-title">Final match report</h3>
        <button type="button" class="fmr-toggle" (click)="showTable = !showTable" [attr.aria-expanded]="showTable">
          <span class="fmr-toggle-chev" aria-hidden="true">{{ showTable ? "▼" : "▶" }}</span>
          {{ showTable ? "Hide table" : "Show table" }}
        </button>
      </div>
      <p class="fmr-intro">
        <strong>Requirement</strong> columns are the <em>seat line</em> (one requirement row). <strong>Candidate</strong>
        columns are that person’s zones, businesses, and <code>candidate_suitable</code>. The last three flags
        re-check: seat business is in candidate B1–B3, zone basis exists for this placement, HR / role line is OK, and
        seat-line gender vs candidate (gender-relax third pass skips strict gender by design). <span class="fmr-legend-ok">Green row</span> =
        all flags pass; <span class="fmr-legend-bad">amber row</span> = open the <strong>Row OK</strong> tooltip to see
        why.
      </p>
      <p *ngIf="!showTable && rows?.length" class="fmr-collapsed-hint">Table is collapsed for a cleaner view — click
        <strong>Show table</strong> to review rows.</p>
      <div *ngIf="showTable && rows?.length; else fmrEmpty" class="fmr-table-scroll">
        <table class="fmr-table">
          <thead>
            <tr>
              <th class="fmr-sticky-left" scope="col">Row OK</th>
              <th scope="col">Req row ID</th>
              <th scope="col">Requirement IC</th>
              <th scope="col">Req zone</th>
              <th scope="col">Req business</th>
              <th scope="col">Req role (seat)</th>
              <th scope="col">Req profile</th>
              <th scope="col">Req discipline</th>
              <th scope="col">Req gender (seat)</th>
              <th scope="col">Candidate email</th>
              <th scope="col">Merit</th>
              <th scope="col">Cand gender</th>
              <th scope="col">Cand zone1</th>
              <th scope="col">Cand zone2</th>
              <th scope="col">Cand zone3</th>
              <th scope="col">Cand bus.1</th>
              <th scope="col">Cand bus.2</th>
              <th scope="col">Cand bus.3</th>
              <th scope="col">candidate_suitable</th>
              <th scope="col">suggested_ic</th>
              <th scope="col">Allocated IC</th>
              <th scope="col">Alloc. zone</th>
              <th scope="col">Alloc. business</th>
              <th scope="col">Alloc. role</th>
              <th scope="col">Phase</th>
              <th scope="col">Zone basis</th>
              <th scope="col">Bus. basis</th>
              <th scope="col">Role fit</th>
              <th scope="col">Bus. match</th>
              <th scope="col">Zone match</th>
              <th scope="col">HR / role match</th>
              <th scope="col">Gender match</th>
              <th scope="col">HR role relax (2nd)</th>
              <th scope="col">HR gender relax (3rd)</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let x of rowsWithAudit" [class.fmr-tr-allok]="x.audit.allOk" [class.fmr-tr-warn]="!x.audit.allOk">
              <th class="fmr-sticky-left" scope="row">
                <span
                  class="fmr-pill"
                  [class.fmr-pill-ok]="x.audit.allOk"
                  [class.fmr-pill-warn]="!x.audit.allOk"
                  [attr.title]="x.audit.issues.length ? x.audit.issues.join(' ') : 'All checked rules pass for this row.'"
                >
                  {{ x.audit.allOk ? "OK" : "!" }}
                </span>
              </th>
              <td>{{ x.row.requirementId ?? "—" }}</td>
              <td [class.fmr-cell-req]="true">{{ x.row.icname || "—" }}</td>
              <td [class.fmr-cell-req]="true">{{ x.row.zone || "—" }}</td>
              <td [class.fmr-cell-req]="true">{{ x.row.business || "—" }}</td>
              <td [class.fmr-cell-req]="true">{{ x.row.requirementRoleName || "—" }}</td>
              <td>{{ x.row.profile || "—" }}</td>
              <td>{{ x.row.discipline || "—" }}</td>
              <td>{{ x.row.requirementGender || "—" }}</td>
              <td class="fmr-cell-clip" [attr.title]="x.row.email">{{ x.row.email }}</td>
              <td class="fmr-num">{{ x.row.meritscore | number : "1.2-2" }}</td>
              <td>{{ x.row.gender || "—" }}</td>
              <td>{{ x.row.zone1 || "—" }}</td>
              <td>{{ x.row.zone2 || "—" }}</td>
              <td>{{ x.row.zone3 || "—" }}</td>
              <td>{{ x.row.business1 || "—" }}</td>
              <td>{{ x.row.business2 || "—" }}</td>
              <td>{{ x.row.business3 || "—" }}</td>
              <td class="fmr-cell-clip" [attr.title]="x.row.candidateSuitable ?? ''">
                {{ x.row.candidateSuitable || "—" }}
              </td>
              <td class="fmr-cell-clip">{{ x.row.suggestedIc || "—" }}</td>
              <td>{{ x.row.icname || "—" }}</td>
              <td>{{ x.row.zone || "—" }}</td>
              <td>{{ x.row.business || "—" }}</td>
              <td>{{ x.row.requirementRoleName || "—" }}</td>
              <td>{{ x.row.preferencePhase || "—" }}</td>
              <td class="fmr-cell-clip">{{ x.row.zoneMatchBasis || "—" }}</td>
              <td class="fmr-cell-clip">{{ x.row.businessMatchBasis || "—" }}</td>
              <td>{{ x.row.roleSuitability || "—" }}</td>
              <td
                class="fmr-flag"
                [class.fmr-flag-yes]="x.audit.businessOk"
                [class.fmr-flag-no]="!x.audit.businessOk"
                [attr.title]="x.audit.businessOk ? 'Seat business is in candidate B1–B3 (or seat has no business).' : 'Seat business not found on candidate lines.'"
              >
                {{ x.audit.businessOk ? "Yes" : "No" }}
              </td>
              <td
                class="fmr-flag"
                [class.fmr-flag-yes]="x.audit.zoneOk"
                [class.fmr-flag-no]="!x.audit.zoneOk"
                [attr.title]="x.audit.zoneOk ? 'Engine recorded a zone match for this phase.' : 'Missing zone match basis.'"
              >
                {{ x.audit.zoneOk ? "Yes" : "No" }}
              </td>
              <td
                class="fmr-flag"
                [class.fmr-flag-yes]="x.audit.hrRoleLineOk && x.audit.hrOk"
                [class.fmr-flag-no]="!(x.audit.hrRoleLineOk && x.audit.hrOk)"
                [attr.title]="hrRoleTitle(x)"
              >
                {{ x.audit.hrRoleLineOk && x.audit.hrOk ? "Yes" : "No" }}
              </td>
              <td
                class="fmr-flag"
                [class.fmr-flag-yes]="x.audit.genderLineOk"
                [class.fmr-flag-no]="!x.audit.genderLineOk"
                [attr.title]="genderMatchTitle(x)"
              >
                {{ x.audit.genderLineOk ? "Yes" : "No" }}
              </td>
              <td>{{ x.row.hrRelaxedSecondPass ? "Yes" : "" }}</td>
              <td>{{ x.row.genderRelaxedThirdPass ? "Yes" : "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ng-template #fmrEmpty>
        <p *ngIf="showTable" class="fmr-empty">No rows in the current assignment view (adjust filters or run allocation).</p>
      </ng-template>
    </div>
  `,
  styles: [
    `
      .fmr-wrap {
        margin: 14px 0 18px;
        padding: 12px 14px 14px;
        background: linear-gradient(180deg, #f0fdf4 0%, #ecfdf5 100%);
        border: 1px solid #86efac;
        border-radius: 10px;
      }
      .fmr-head {
        display: flex;
        flex-wrap: wrap;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        margin-bottom: 6px;
      }
      .fmr-title {
        margin: 0;
        font-size: 1.05rem;
      }
      .fmr-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 6px 12px;
        font-size: 12px;
        font-weight: 600;
        color: #14532d;
        background: #fff;
        border: 1px solid #86efac;
        border-radius: 8px;
        cursor: pointer;
        font-family: inherit;
      }
      .fmr-toggle:hover {
        background: #ecfdf5;
      }
      .fmr-toggle-chev {
        font-size: 10px;
        color: #15803d;
      }
      .fmr-collapsed-hint {
        margin: 0 0 10px;
        font-size: 12px;
        color: #166534;
      }
      .fmr-intro {
        margin: 0 0 12px;
        font-size: 13px;
        line-height: 1.45;
        color: #14532d;
      }
      .fmr-legend-ok {
        font-weight: 600;
        color: #15803d;
      }
      .fmr-legend-bad {
        font-weight: 600;
        color: #b45309;
      }
      .fmr-table-scroll {
        overflow-x: auto;
        border-radius: 8px;
        border: 1px solid #bbf7d0;
        background: #fff;
      }
      .fmr-table {
        width: max-content;
        min-width: 100%;
        border-collapse: collapse;
        font-size: 12px;
      }
      .fmr-table th,
      .fmr-table td {
        border: 1px solid #d1fae5;
        padding: 6px 8px;
        text-align: left;
        vertical-align: top;
        white-space: nowrap;
      }
      .fmr-table thead th {
        background: #22c55e;
        color: #fff;
        font-weight: 600;
        position: sticky;
        top: 0;
        z-index: 1;
      }
      .fmr-sticky-left {
        position: sticky;
        left: 0;
        z-index: 2;
        background: #ecfdf5;
        box-shadow: 2px 0 4px rgba(0, 0, 0, 0.06);
      }
      .fmr-table thead .fmr-sticky-left {
        background: #16a34a;
        z-index: 3;
      }
      .fmr-tr-allok td,
      .fmr-tr-allok th {
        background: #f0fdf4;
      }
      .fmr-tr-warn td,
      .fmr-tr-warn th {
        background: #fffbeb;
      }
      .fmr-tr-warn .fmr-sticky-left {
        background: #fef3c7;
      }
      .fmr-pill {
        display: inline-block;
        min-width: 2rem;
        padding: 2px 8px;
        border-radius: 999px;
        font-weight: 700;
        font-size: 11px;
        text-align: center;
      }
      .fmr-pill-ok {
        background: #22c55e;
        color: #fff;
      }
      .fmr-pill-warn {
        background: #f59e0b;
        color: #fff;
      }
      .fmr-cell-req {
        background: #dcfce7;
        font-weight: 600;
        color: #14532d;
      }
      .fmr-tr-warn .fmr-cell-req {
        background: #fef08a;
      }
      .fmr-cell-clip {
        max-width: 140px;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .fmr-num {
        text-align: right;
      }
      .fmr-flag {
        font-weight: 700;
        text-align: center;
      }
      .fmr-flag-yes {
        background: #bbf7d0;
        color: #166534;
      }
      .fmr-flag-no {
        background: #fecaca;
        color: #991b1b;
      }
      .fmr-empty {
        margin: 8px 0 0;
        color: #64748b;
        font-size: 13px;
      }
    `
  ]
})
export class FinalMatchReportComponent {
  @Input() rows: FinalMatchReportRow[] = [];
  /** Table body hidden by default so the assignments area stays compact. */
  showTable = false;

  get rowsWithAudit(): Array<{ row: FinalMatchReportRow; audit: FinalMatchAudit }> {
    return (this.rows ?? []).map((row) => ({ row, audit: auditFinalMatchRow(row) }));
  }

  genderMatchTitle(x: { row: FinalMatchReportRow; audit: FinalMatchAudit }): string {
    if (x.row.genderRelaxedThirdPass) {
      return "Gender-relax third pass: seat-line gender was not enforced for this placement.";
    }
    if (x.audit.genderLineOk) {
      return "Candidate gender matches seat line (or seat line gender not set).";
    }
    return "Seat line gender does not match candidate gender.";
  }

  hrRoleTitle(x: { row: FinalMatchReportRow; audit: FinalMatchAudit }): string {
    if (x.row.hrRelaxedSecondPass) {
      return "HR-relax second pass: seat role_name was not enforced for this placement.";
    }
    if (x.audit.hrRoleLineOk && x.audit.hrOk) {
      return "HR OK: candidate_suitable matches seat role line when the seat defines one; otherwise not required.";
    }
    const hrIssues = x.audit.issues.filter((i) => /role|HR/i.test(i));
    return hrIssues.length ? hrIssues.join(" ") : "Review candidate_suitable vs seat role_name.";
  }
}
