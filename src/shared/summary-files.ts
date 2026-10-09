import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { ensure } from "./errors.js";
export function requireSummaryStorage() {
  ensure(process.env.VERCEL !== "1", 503, "PDF_STORAGE_UNAVAILABLE_ON_VERCEL");
}
export const summaryDirectory = path.resolve("storage", "summary-pdfs");
export async function saveSummaryPdf(bytes: Buffer) {
  requireSummaryStorage();
  await mkdir(summaryDirectory, { recursive: true });
  const filename = `${randomUUID()}.pdf`;
  await writeFile(path.join(summaryDirectory, filename), bytes, { flag: "wx" });
  return `/api/v1/summary-pdfs/${filename}`;
}
