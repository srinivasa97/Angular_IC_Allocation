import { Component, Input, OnInit } from "@angular/core";
import { NgIf } from "@angular/common";

/**
 * Expand/collapse wrapper for table-heavy sections. Keeps a single clickable header visible when collapsed.
 */
@Component({
  selector: "app-collapsible-section",
  standalone: true,
  imports: [NgIf],
  template: `
    <section [class]="hostClass">
      <button type="button" class="cs-toggle" (click)="open = !open" [attr.aria-expanded]="open">
        <span class="cs-chev" aria-hidden="true">{{ open ? "▼" : "▶" }}</span>
        <span class="cs-title">{{ title }}</span>
      </button>
      <div class="cs-body" *ngIf="open">
        <ng-content></ng-content>
      </div>
    </section>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .cs-toggle {
        display: flex;
        align-items: center;
        gap: 10px;
        width: 100%;
        text-align: left;
        margin: 0 0 10px;
        padding: 10px 12px;
        font-size: 1.05rem;
        font-weight: 600;
        color: #0f172a;
        background: #f8fafc;
        border: 1px solid #e2e8f0;
        border-radius: 8px;
        cursor: pointer;
        font-family: inherit;
      }
      .cs-toggle:hover {
        background: #f1f5f9;
      }
      .cs-chev {
        flex: 0 0 auto;
        width: 1.1rem;
        font-size: 0.7rem;
        color: #64748b;
        line-height: 1;
      }
      .cs-title {
        flex: 1;
        line-height: 1.3;
      }
      .cs-body {
        padding-top: 2px;
      }
    `
  ]
})
export class CollapsibleSectionComponent implements OnInit {
  @Input({ required: true }) title!: string;
  /** Extra CSS classes on the outer section element (e.g. "block ic-report-section"). */
  @Input() sectionClass = "block";
  /** When true, body is shown on first render. */
  @Input() startOpen = false;

  open = false;

  get hostClass(): string {
    return (this.sectionClass ?? "block").trim() || "block";
  }

  ngOnInit(): void {
    this.open = this.startOpen;
  }
}
