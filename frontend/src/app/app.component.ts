import { Component } from "@angular/core";
import { RouterLink, RouterLinkActive, RouterOutlet } from "@angular/router";

@Component({
  selector: "app-root",
  standalone: true,
  imports: [RouterOutlet, RouterLink, RouterLinkActive],
  template: `
    <div class="app-shell">
      <header class="app-header">
        <div class="app-header-inner">
          <div class="app-brand">
            <h1>IC Trainee Allocation</h1>
            <p>Simulate, run, and audit merit-based allocation to zones and ICs.</p>
          </div>
          <nav class="app-nav" aria-label="Main">
            <a routerLink="/dashboard" routerLinkActive="active">Dashboard</a>
            <a routerLink="/simulate" routerLinkActive="active">Simulator</a>
            <a routerLink="/run" routerLinkActive="active">Run</a>
            <a routerLink="/logs" routerLinkActive="active">Logs</a>
            <a routerLink="/manual" routerLinkActive="active">Manual</a>
            <a routerLink="/admin/sequences" routerLinkActive="active">Sequences</a>
          </nav>
        </div>
      </header>
      <router-outlet></router-outlet>
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
    `
  ]
})
export class AppComponent {}
