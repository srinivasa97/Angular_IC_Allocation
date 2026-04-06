import { z } from "zod";
import { withTransaction } from "../db.js";

const manualSchema = z.object({
  email: z.string().email(),
  zone: z.string().min(1),
  business: z.string().min(1),
  icname: z.string().min(1)
});

export async function manualAllocate(payload: unknown) {
  const body = manualSchema.parse(payload);
  return withTransaction(async (conn) => {
    const [candidateRows] = await conn.query("SELECT * FROM candidates WHERE email = ? LIMIT 1", [body.email]);
    const candidates = candidateRows as Array<{ id: number; gender: string; profile: string; discipline: string }>;
    if (!candidates.length) {
      throw new Error("Candidate not found");
    }
    const candidate = candidates[0];
    const [reqRows] = await conn.query(
      `
      SELECT id FROM requirements
      WHERE gender = ? AND profile = ? AND discipline = ? AND zone = ? AND business = ? AND icname = ? AND remaining > 0
      LIMIT 1
      `,
      [candidate.gender, candidate.profile, candidate.discipline, body.zone, body.business, body.icname]
    );
    const req = (reqRows as Array<{ id: number }>)[0];
    if (!req) {
      throw new Error("No remaining slot for selected requirement");
    }
    await conn.query("UPDATE requirements SET allocated = allocated + 1 WHERE id = ?", [req.id]);
    await conn.query(
      "UPDATE candidates SET allocated_zone = ?, allocated_business = ?, allocated_ic = ?, isManual = 1 WHERE id = ?",
      [body.zone, body.business, body.icname, candidate.id]
    );
    return { ok: true };
  });
}
