import { Component, OnInit, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { DecimalPipe, NgFor, NgIf } from "@angular/common";
import { ApiService } from "../api.service";
import { CollapsibleSectionComponent } from "../components/collapsible-section.component";
import { filterRowsIndexed, topZoneFilterCols, type ColumnFilterDef } from "../table-filter.util";

type DashboardRow = {
  total?: unknown;
  unallocated?: unknown;
  rows_count?: unknown;
  capacity_total?: unknown;
  allocated_total?: unknown;
  remaining_total?: unknown;
};

type TopZone = { zone: string; count: unknown };

type DashboardPayload = {
  candidates?: DashboardRow;
  requirements?: DashboardRow;
  topZones?: TopZone[];
};

@Component({
  standalone: true,
  imports: [NgIf, NgFor, DecimalPipe, FormsModule, CollapsibleSectionComponent],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Dashboard</h2>
          <p class="page-desc">
            Live counts from your <code>candidates</code> and <code>requirements</code> tables. Refresh after a run to see updates.
          </p>
        </div>
        <button type="button" class="btn btn-primary" (click)="load()" [disabled]="loading">
          {{ loading ? "Refreshing…" : "Refresh" }}
        </button>
      </div>

      <p *ngIf="error" class="alert alert-error">{{ error }}</p>

      <ng-container *ngIf="data as d">
        <div class="kpi-grid">
          <div class="kpi-tile accent">
            <span class="kpi-label">Candidates</span>
            <span class="kpi-value">{{ num(d.candidates?.total) | number }}</span>
            <span class="kpi-sub">Total in pool</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Still open</span>
            <span class="kpi-value">{{ num(d.candidates?.unallocated) | number }}</span>
            <span class="kpi-sub">No IC allocation yet</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Requirement rows</span>
            <span class="kpi-value">{{ num(d.requirements?.rows_count) | number }}</span>
            <span class="kpi-sub">Distinct IC / zone / business lines</span>
          </div>
          <div class="kpi-tile success">
            <span class="kpi-label">Open seats</span>
            <span class="kpi-value">{{ num(d.requirements?.remaining_total) | number }}</span>
            <span class="kpi-sub">Σ(newvalue − allocated)</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Total capacity</span>
            <span class="kpi-value">{{ num(d.requirements?.capacity_total) | number }}</span>
            <span class="kpi-sub">Planned seats (newvalue)</span>
          </div>
          <div class="kpi-tile">
            <span class="kpi-label">Filled</span>
            <span class="kpi-value">{{ num(d.requirements?.allocated_total) | number }}</span>
            <span class="kpi-sub">Already allocated</span>
          </div>
        </div>

        <div class="progress-wrap" *ngIf="num(d.requirements?.capacity_total) > 0">
          <div class="progress-label">
            <span>Requirement fill</span>
            <span
              >{{ pctFilled(d) | number : "1.1-1" }}% ({{
                num(d.requirements?.allocated_total) | number
              }}
              / {{ num(d.requirements?.capacity_total) | number }})</span
            >
          </div>
          <div class="progress-bar">
            <div class="progress-fill" [style.width.%]="pctFilled(d)"></div>
          </div>
        </div>

        <app-collapsible-section
          title="Top allocated zones"
          sectionClass="dash-zones-block"
          [startOpen]="false"
        >
          <p class="page-desc" style="margin-top: 4px;">
            Where trainees are currently posted (<code>allocated_zone</code>). Use search / column filters to narrow rows.
          </p>
          <ng-container *ngIf="d.topZones?.length">
            <div class="table-filter-toolbar">
              <input
                type="search"
                class="table-filter-global"
                [(ngModel)]="topZoneGlobal"
                placeholder="Search #, zone, count…"
                aria-label="Search zones"
              />
              <button type="button" class="btn btn-secondary" (click)="showTopZoneColFilters = !showTopZoneColFilters">
                {{ showTopZoneColFilters ? "Hide" : "Show" }} column filters
              </button>
              <button type="button" class="btn btn-secondary" (click)="clearTopZoneFilters()">Clear</button>
              <span class="muted">{{ filteredTopZoneItems.length }} / {{ d.topZones!.length }} rows</span>
            </div>
            <div class="col-filters-grid" *ngIf="showTopZoneColFilters">
              <label *ngFor="let c of topZoneFilterColDefs">
                {{ c.label }}
                <input type="text" [(ngModel)]="topZoneCol[c.key]" [attr.aria-label]="'Filter ' + c.label" />
              </label>
            </div>
          </ng-container>
          <div class="data-table-wrap data-table-scroll" *ngIf="d.topZones?.length; else noZones">
            <table class="data-table">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Zone</th>
                  <th>Count</th>
                </tr>
              </thead>
              <tbody>
                <tr *ngFor="let item of filteredTopZoneItems">
                  <td>{{ item.origIndex + 1 }}</td>
                  <td>{{ item.row.zone }}</td>
                  <td>{{ num(item.row.count) | number }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <ng-template #noZones>
            <p class="alert alert-muted">No zone allocations yet — run allocation or check candidates.</p>
          </ng-template>
        </app-collapsible-section>
      </ng-container>

      <p *ngIf="!loading && !data && !error" class="muted">No data loaded.</p>
    </div>
  `,
  styles: [
    `
      .dash-zones-block {
        margin-top: 28px;
      }
    `
  ]
})
export class DashboardComponent implements OnInit {
  private readonly api = inject(ApiService);
  data: DashboardPayload | null = null;
  loading = false;
  error = "";

  readonly topZoneFilterColDefs = topZoneFilterCols();
  topZoneGlobal = "";
  topZoneCol: Record<string, string> = {};
  showTopZoneColFilters = false;

  get filteredTopZoneItems(): { row: TopZone; origIndex: number }[] {
    const rows = this.data?.topZones ?? [];
    return filterRowsIndexed(
      rows,
      this.topZoneFilterColDefs as ColumnFilterDef<TopZone>[],
      this.topZoneGlobal,
      this.topZoneCol
    );
  }

  clearTopZoneFilters(): void {
    this.topZoneGlobal = "";
    this.topZoneCol = {};
  }

  ngOnInit(): void {
    this.load();
  }

  num(v: unknown): number {
    if (v == null || v === "") return 0;
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }

  pctFilled(d: DashboardPayload): number {
    const cap = this.num(d.requirements?.capacity_total);
    if (cap <= 0) return 0;
    return Math.min(100, (this.num(d.requirements?.allocated_total) / cap) * 100);
  }

  load(): void {
    this.loading = true;
    this.error = "";
    this.api.dashboard().subscribe({
      next: (res) => {
        this.data = res as DashboardPayload;
        this.clearTopZoneFilters();
        this.showTopZoneColFilters = false;
        this.loading = false;
      },
      error: (e) => {
        this.error = e?.error?.error ?? e?.message ?? "Failed to load dashboard";
        this.loading = false;
      }
    });
  }
}
