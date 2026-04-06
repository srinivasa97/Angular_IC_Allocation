import cors from "cors";
import dotenv from "dotenv";
import express from "express";
import { executeAllocation } from "./services/allocation-engine.js";
import { getDashboard } from "./services/dashboard-service.js";
import { getAllocationLogs } from "./services/logs-service.js";
import { manualAllocate } from "./services/manual-service.js";
import { getSequenceTable, prepareRequirements, updateSequenceRow } from "./services/admin-service.js";
import { getAllocationFilterOptions } from "./services/filter-options-service.js";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    const data = await getDashboard();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/allocation/simulate", async (req, res) => {
  try {
    const data = await executeAllocation("simulate", req.body);
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post("/api/allocation/run", async (req, res) => {
  try {
    const data = await executeAllocation("run", req.body);
    res.json(data);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get("/api/allocation/filter-options", async (req, res) => {
  try {
    const profile = typeof req.query.profile === "string" ? req.query.profile : undefined;
    const gender = typeof req.query.gender === "string" ? req.query.gender : undefined;
    const discipline = typeof req.query.discipline === "string" ? req.query.discipline : undefined;
    const data = await getAllocationFilterOptions({ profile, gender, discipline });
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.get("/api/allocation/logs", async (req, res) => {
  try {
    const data = await getAllocationLogs(Number(req.query.limit ?? 200));
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: (error as Error).message });
  }
});

app.post("/api/manual/allocate", async (req, res) => {
  try {
    const result = await manualAllocate(req.body);
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.get("/api/admin/sequences/:table", async (req, res) => {
  try {
    const rows = await getSequenceTable(req.params.table);
    res.json(rows);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.put("/api/admin/sequences/:table/:id", async (req, res) => {
  try {
    const result = await updateSequenceRow(req.params.table, Number(req.params.id), req.body ?? {});
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

app.post("/api/admin/prepare-requirements", async (_req, res) => {
  try {
    const result = await prepareRequirements();
    res.json(result);
  } catch (error) {
    res.status(400).json({ error: (error as Error).message });
  }
});

const port = Number(process.env.PORT ?? 4000);
app.listen(port, () => {
  console.log(`Server listening on ${port}`);
});
