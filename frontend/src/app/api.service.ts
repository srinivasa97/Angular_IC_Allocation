import { Injectable, inject } from "@angular/core";
import { HttpClient, HttpParams } from "@angular/common/http";
import type { Observable } from "rxjs";

export type RequirementSliceStats = {
  requirementRowCount: number;
  totalSeatsNewvalue: number;
};

export type AllocationFilterOptions = {
  genders: string[];
  profiles: string[];
  disciplines: string[];
  requirementSlice: RequirementSliceStats;
};

@Injectable({ providedIn: "root" })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = "http://localhost:4000/api";

  dashboard() {
    return this.http.get(`${this.base}/dashboard`);
  }

  allocationFilterOptions(params?: {
    profile?: string;
    gender?: string;
    discipline?: string;
  }): Observable<AllocationFilterOptions> {
    let hp = new HttpParams();
    if (params?.profile?.trim()) hp = hp.set("profile", params.profile.trim());
    if (params?.gender?.trim()) hp = hp.set("gender", params.gender.trim());
    if (params?.discipline?.trim()) hp = hp.set("discipline", params.discipline.trim());
    return this.http.get<AllocationFilterOptions>(`${this.base}/allocation/filter-options`, { params: hp });
  }

  simulate(payload: Record<string, unknown>) {
    return this.http.post(`${this.base}/allocation/simulate`, payload);
  }

  run(payload: Record<string, unknown>) {
    return this.http.post(`${this.base}/allocation/run`, payload);
  }

  logs(limit = 200) {
    return this.http.get(`${this.base}/allocation/logs?limit=${limit}`);
  }

  manualAllocate(payload: Record<string, unknown>) {
    return this.http.post(`${this.base}/manual/allocate`, payload);
  }

  sequence(table: string) {
    return this.http.get<Array<Record<string, unknown>>>(`${this.base}/admin/sequences/${table}`);
  }

  updateSequence(table: string, id: number, patch: Record<string, unknown>) {
    return this.http.put(`${this.base}/admin/sequences/${table}/${id}`, patch);
  }
}
