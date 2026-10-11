import type { Response } from "express";
import { Expense, Order } from "../modules/domain/models.js";
import type { Principal } from "../modules/staff-assignments/service.js";
import { ensure } from "./errors.js";

// Find projections return presence only; receipt bytes never leave Mongo in list reads.
export const receiptPresence = { $ne: [{ $ifNull: ["$receiptImage", null] }, null] };
export function receiptReference(id: unknown, kind: "expenses" | "orders") {
  return `/api/v1/${kind === "expenses" ? "staff" : "admin"}/${kind}/${String(id)}/receipt`;
}
export async function loadReceipt(user: Principal, kind: "expenses" | "orders", id: string) {
  ensure(kind === "expenses" || user.role === "super_admin", 403, "FORBIDDEN");
  const record = await (kind === "expenses" ? Expense : Order).findById(id)
    .select("createdBy receiptImage receiptUrl").lean();
  ensure(record, 404, "NOT_FOUND");
  ensure(user.role === "super_admin" || String(record.createdBy) === user.userId, 403, "FORBIDDEN");
  const value = record.receiptImage || record.receiptUrl;
  ensure(typeof value === "string" && value.length > 0, 404, "RECEIPT_NOT_FOUND");
  const inline = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (inline) return { mime: inline[1]!, bytes: Buffer.from(inline[2]!, "base64") };
  ensure(value.startsWith("https://") || /^\/api\/v1\/files\/[a-f\d]{24}\.(?:png|jpg|webp|pdf)$/.test(value), 404, "RECEIPT_NOT_FOUND");
  return { url: value };
}
export function sendReceipt(res: Response, receipt: Awaited<ReturnType<typeof loadReceipt>>) {
  res.setHeader("Cache-Control", "private, no-store");
  if (receipt.url) res.redirect(302, receipt.url);
  else res.type(receipt.mime!).send(receipt.bytes);
}
