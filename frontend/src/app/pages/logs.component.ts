import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { JsonPipe, NgFor, NgIf } from "@angular/common";
import { ApiService } from "../api.service";
import { dynamicRecordFilterCols, filterRowsIndexed } from "../table-filter.util";

type LogsPayload = {
  business?: Record<string, unknown>[];
  zone?: Record<string, unknown>[];
};

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgIf, NgFor],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Allocation logs</h2>
          <p class="page-desc">
            Recent rows from business and zone log tables. Switch tabs to change the dataset.
          </p>
        </div>
        <div class="logs-toolbar">
          <label class="form-field" style="margin:0; min-width: 6rem;">
            <span>Limit</span>
            <input type="number" min="1" max="2000" [(ngModel)]="limit" />
          </label>
          <button type="button" class="btn btn-secondary" (click)="load()" [disabled]="loading">
            {{ loading ? "Loading…" : "Refresh" }}
          </button>
        </div>
      </div>

      <p *ngIf="error" class="alert alert-error">{{ error }}</p>

      <div class="subtabs" role="tablist" aria-label="Log type">
        <button
          type="button"
          class="subtab"
          [class.active]="activeTab === 'business'"
          (click)="setLogTab('business')"
          role="tab"
          [attr.aria-selected]="activeTab === 'business'"
        >
          Business
          <span class="tab-count" *ngIf="data?.business">({{ data!.business!.length }})</span>
        </button>
        <button
          type="button"
          class="subtab"
          [class.active]="activeTab === 'zone'"
          (click)="setLogTab('zone')"
          role="tab"
          [attr.aria-selected]="activeTab === 'zone'"
        >
          Zone
          <span class="tab-count" *ngIf="data?.zone">({{ data!.zone!.length }})</span>
        </button>
      </div>

      <ng-container *ngIf="currentRows.length">
        <div class="table-filter-toolbar">
          <input
            type="search"
            class="table-filter-global"
            [(ngModel)]="tableGlobal"
            placeholder="Search all columns…"
            aria-label="Search log rows"
          />
          <button type="button" class="btn btn-secondary" (click)="showColFilters = !showColFilters">
            {{ showColFilters ? "Hide" : "Show" }} column filters
          </button>
          <button type="button" class="btn btn-secondary" (click)="clearTableFilters()">Clear</button>
          <span class="muted">{{ filteredLogRows.length }} / {{ currentRows.length }} rows</span>
        </div>
        <div class="col-filters-grid" *ngIf="showColFilters">
          <label *ngFor="let c of logFilterColDefs">
            {{ c.label }}
            <input type="text" [(ngModel)]="tableCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
          </label>
        </div>
      </ng-container>

      <div class="data-table-wrap data-table-scroll" *ngIf="currentRows.length; else empty">
        <table class="data-table">
          <thead>
            <tr>
              <th *ngFor="let c of columnKeys">{{ formatHeader(c) }}</th>
            </tr>
          </thead>
          <tbody>
            <tr *ngFor="let row of filteredLogRows">
              <td *ngFor="let c of columnKeys">{{ formatCell(row[c]) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <ng-template #empty>
        <p *ngIf="!loading && data" class="alert alert-muted">No rows in this log for the current limit.</p>
      </ng-template>

      <label class="form-check" style="margin-top: 20px;">
        <input type="checkbox" [(ngModel)]="showRaw" />
        Show raw JSON
      </label>
      <pre *ngIf="showRaw" class="raw-json">{{ data | json }}</pre>
    </div>
  `,
  styles: [
    `
      .logs-toolbar {
        display: flex;
        flex-wrap: wrap;
        align-items: flex-end;
        gap: 12px;
      }
      .tab-count {
        font-weight: 500;
        opacity: 0.85;
      }
    `
  ]
})
export class LogsComponent implements OnInit {
  private readonly api = inject(ApiService);
  limit = 200;
  data: LogsPayload | null = null;
  loading = false;
  error = "";
  activeTab: "business" | "zone" = "business";
  showRaw = false;

  tableGlobal = "";
  tableCol: Record<string, string> = {};
  showColFilters = false;

  ngOnInit(): void {
    this.load();
  }

  get currentRows(): Record<string, unknown>[] {
    if (!this.data) return [];
    const key = this.activeTab;
    const rows = this.data[key];
    return Array.isArray(rows) ? (rows as Record<string, unknown>[]) : [];
  }

  get columnKeys(): string[] {
    const first = this.currentRows[0];
    if (!first) return [];
    return Object.keys(first);
  }

  get logFilterColDefs() {
    return dynamicRecordFilterCols(this.columnKeys);
  }

  get filteredLogRows(): Record<string, unknown>[] {
    const rows = this.currentRows;
    const cols = this.logFilterColDefs;
    if (!rows.length || !cols.length) return rows;
    return filterRowsIndexed(rows, cols, this.tableGlobal, this.tableCol).map((x) => x.row);
  }

  setLogTab(tab: "business" | "zone"): void {
    this.activeTab = tab;
    this.clearTableFilters();
    this.showColFilters = false;
  }

  clearTableFilters(): void {
    this.tableGlobal = "";
    this.tableCol = {};
  }

  formatHeader(key: string): string {
    return key.replace(/_/g, " ");
  }

  formatCell(v: unknown): string {
    if (v == null) return "—";
    if (typeof v === "object") return JSON.stringify(v);
    return String(v);
  }

  load(): void {
    this.loading = true;
    this.error = "";
    this.api.logs(this.limit).subscribe({
      next: (res) => {
        this.data = res as LogsPayload;
        this.clearTableFilters();
        this.showColFilters = false;
        this.loading = false;
      },
      error: (e) => {
        this.error = e?.error?.error ?? e?.message ?? "Failed to load logs";
        this.loading = false;
      }
    });
  }
}
