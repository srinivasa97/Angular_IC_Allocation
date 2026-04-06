import { Component, inject } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { JsonPipe, NgIf } from "@angular/common";
import { ApiService } from "../api.service";

@Component({
  standalone: true,
  imports: [FormsModule, JsonPipe, NgIf],
  template: `
    <div class="page-card">
      <div class="page-header">
        <div>
          <h2 class="page-title">Manual allocation override</h2>
          <p class="page-desc">
            Force a candidate into a specific zone, business line, and IC. Use when HR needs an exception outside the automated run.
          </p>
        </div>
      </div>

      <div class="form-grid">
        <div class="form-field">
          <label for="m-email">Candidate email</label>
          <input id="m-email" type="email" [(ngModel)]="form['email']" placeholder="name@example.com" autocomplete="off" />
        </div>
        <div class="form-field">
          <label for="m-zone">Zone</label>
          <input id="m-zone" type="text" [(ngModel)]="form['zone']" placeholder="e.g. North" />
        </div>
        <div class="form-field">
          <label for="m-business">Business</label>
          <input id="m-business" type="text" [(ngModel)]="form['business']" placeholder="Business line" />
        </div>
        <div class="form-field">
          <label for="m-ic">IC name</label>
          <input id="m-ic" type="text" [(ngModel)]="form['icname']" placeholder="IC display name" />
        </div>
      </div>

      <div style="margin-top: 20px;">
        <button type="button" class="btn btn-primary" (click)="save()" [disabled]="saving">
          {{ saving ? "Applying…" : "Apply manual allocation" }}
        </button>
      </div>

      <p *ngIf="messageOk" class="alert alert-success">{{ messageOk }}</p>
      <p *ngIf="messageErr" class="alert alert-error">{{ messageErr }}</p>

      <label class="form-check" style="margin-top: 16px;">
        <input type="checkbox" [(ngModel)]="showRaw" />
        Show full response JSON
      </label>
      <pre *ngIf="showRaw && result != null" class="raw-json">{{ result | json }}</pre>
    </div>
  `
})
export class ManualComponent {
  private readonly api = inject(ApiService);
  form: Record<string, unknown> = {};
  result: unknown;
  saving = false;
  messageOk = "";
  messageErr = "";
  showRaw = false;

  save(): void {
    this.saving = true;
    this.messageOk = "";
    this.messageErr = "";
    this.result = undefined;
    this.api.manualAllocate(this.form).subscribe({
      next: (res) => {
        this.result = res;
        this.messageOk =
          typeof res === "object" && res !== null && "message" in res
            ? String((res as { message?: unknown }).message ?? "Saved.")
            : "Allocation updated.";
        this.saving = false;
      },
      error: (e) => {
        const err = e?.error;
        this.messageErr =
          typeof err === "object" && err !== null && "error" in err
            ? String((err as { error?: unknown }).error)
            : typeof err === "string"
              ? err
              : e?.message ?? "Request failed";
        this.result = err ?? e?.message;
        this.saving = false;
      }
    });
  }
}
