import { Routes } from "@angular/router";
import { DashboardComponent } from "./pages/dashboard.component";
import { SimulateComponent } from "./pages/simulate.component";
import { RunComponent } from "./pages/run.component";
import { LogsComponent } from "./pages/logs.component";
import { ManualComponent } from "./pages/manual.component";
import { AdminSequencesComponent } from "./pages/admin-sequences.component";

export const appRoutes: Routes = [
  { path: "", redirectTo: "dashboard", pathMatch: "full" },
  { path: "dashboard", component: DashboardComponent },
  { path: "simulate", component: SimulateComponent },
  { path: "run", component: RunComponent },
  { path: "logs", component: LogsComponent },
  { path: "manual", component: ManualComponent },
  { path: "admin/sequences", component: AdminSequencesComponent }
];
