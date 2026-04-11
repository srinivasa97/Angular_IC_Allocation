import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { JsonPipe, NgFor, NgIf } from "@angular/common";
import { ApiService } from "../api.service";
import { CollapsibleSectionComponent } from "../components/collapsible-section.component";
import { dynamicRecordFilterCols, filterRowsIndexed } from "../table-filter.util";

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgIf, NgFor, CollapsibleSectionComponent],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Admin — sequence tables</h2>
          <p class="page-desc">
            Read-only view of ordering tables used by allocation (gender, profile/discipline, zone, business).
          </p>
        </div>
        <div class="admin-toolbar">
          <label class="form-field" style="margin:0;">
            <span>Table</span>
            <select [(ngModel)]="table" (ngModelChange)="load()">
              <option value="seq_gender">seq_gender</option>
              <option value="seq_profile_discipline">seq_profile_discipline</option>
              <option value="seq_zone">seq_zone</option>
              <option value="seq_business">seq_business</option>
            </select>
          </label>
          <button type="button" class="btn btn-secondary" (click)="load()" [disabled]="loading">
            {{ loading ? "Loading…" : "Reload" }}
          </button>
        </div>
      </div>

      <p *ngIf="error" class="alert alert-error">{{ error }}</p>

      <app-collapsible-section
        *ngIf="rows.length"
        [title]="'Sequence table — ' + table + ' (' + rows.length + ' rows)'"
        sectionClass="admin-seq-collapse"
        [startOpen]="false"
      >
        <div class="table-filter-toolbar">
          <input
            type="search"
            class="table-filter-global"
            [(ngModel)]="tableGlobal"
            placeholder="Search all columns…"
            aria-label="Search sequence rows"
          />
          <button type="button" class="btn btn-secondary" (click)="showColFilters = !showColFilters">
            {{ showColFilters ? "Hide" : "Show" }} column filters
          </button>
          <button type="button" class="btn btn-secondary" (click)="clearTableFilters()">Clear</button>
          <span class="muted">{{ filteredRows.length }} / {{ rows.length }} rows</span>
        </div>
        <div class="col-filters-grid" *ngIf="showColFilters">
          <label *ngFor="let c of sequenceFilterColDefs">
            {{ c.label }}
            <input type="text" [(ngModel)]="tableCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
          </label>
        </div>
        <div class="data-table-wrap data-table-scroll">
          <table class="data-table">
            <thead>
              <tr>
                <th *ngFor="let c of columnKeys">{{ c }}</th>
              </tr>
            </thead>
            <tbody>
              <tr *ngFor="let row of filteredRows">
                <td *ngFor="let c of columnKeys">{{ formatCell(row[c]) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </app-collapsible-section>
      <p *ngIf="!loading && !error && !rows.length" class="alert alert-muted">No rows returned.</p>

      <label class="form-check" style="margin-top: 20px;">
        <input type="checkbox" [(ngModel)]="showRaw" />
        Show raw JSON
      </label>
      <pre *ngIf="showRaw" class="raw-json">{{ rows | json }}</pre>
    </div>
  `,
  styles: [
    `
      .admin-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 12px;
      }
      .admin-seq-collapse {
        margin-top: 16px;
      }
    `
  ]
})
export class AdminSequencesComponent implements OnInit {
  private readonly api = inject(ApiService);
  table = "seq_gender";
  rows: Record<string, unknown>[] = [];
  loading = false;
  error = "";
  showRaw = false;

  tableGlobal = "";
  tableCol: Record<string, string> = {};
  showColFilters = false;

  ngOnInit(): void {
    this.load();
  }

  get columnKeys(): string[] {
    const first = this.rows[0];
    return first ? Object.keys(first) : [];
  }

  get sequenceFilterColDefs() {
    return dynamicRecordFilterCols(this.columnKeys);
  }

  get filteredRows(): Record<string, unknown>[] {
    const cols = this.sequenceFilterColDefs;
    if (!this.rows.length || !cols.length) return this.rows;
    return filterRowsIndexed(this.rows, cols, this.tableGlobal, this.tableCol).map((x) => x.row);
  }

  clearTableFilters(): void {
    this.tableGlobal = "";
    this.tableCol = {};
  }

  formatCell(v: unknown): string {
    if (v == null) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  load(): void {
    this.loading = true;
    this.error = "";
    this.api.sequence(this.table).subscribe({
      next: (res) => {
        this.rows = Array.isArray(res) ? res : [];
        this.clearTableFilters();
        this.showColFilters = false;
        this.loading = false;
      },
      error: (e) => {
        this.error = e?.error?.error ?? e?.message ?? "Failed to load table";
        this.rows = [];
        this.loading = false;
      }
    });
  }
}
