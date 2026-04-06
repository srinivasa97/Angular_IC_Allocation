/** Read first matching string field (exact key, then case-insensitive key). */
export function pickRowString(row: Record<string, unknown>, names: string[]): string {
  for (const n of names) {
    if (Object.prototype.hasOwnProperty.call(row, n)) {
      return stringifyCell(row[n]).trim();
    }
  }
  for (const key of Object.keys(row)) {
    const kl = key.toLowerCase();
    for (const n of names) {
      if (kl === n.toLowerCase()) {
        return stringifyCell(row[key]).trim();
      }
    }
  }
  return "";
}

function stringifyCell(value: unknown): string {
  if (value == null) return "";
  if (typeof value === "string") return value;
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf8");
  return String(value);
}
