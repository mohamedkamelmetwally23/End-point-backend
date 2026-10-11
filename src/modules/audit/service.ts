import { fields } from "../../shared/dto.js";
import { pageQuery, pageResult } from "../../shared/pagination.js";
import type { ClientSession } from "mongoose";
import { AuditLog } from "../domain/models.js";
export async function audit(
  actor: unknown,
  action: string,
  entityType: string,
  entityId: unknown,
  metadata: unknown = {},
  session?: ClientSession,
) {
  await AuditLog.create(
    [{ actor, action, entityType, entityId: String(entityId), metadata }],
    session ? { session } : {},
  );
}

export async function frequentLoginsToday() {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Cairo", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  return AuditLog.aggregate([
    { $match: { action: "auth.login", timestamp: { $gte: new Date(Date.now() - 48 * 3600000) } } },
    { $match: { $expr: { $eq: [{ $dateToString: { date: "$timestamp", format: "%Y-%m-%d", timezone: "Africa/Cairo" } }, today] } } },
    { $group: { _id: "$actor", count: { $sum: 1 }, lastLogin: { $max: "$timestamp" } } },
    { $match: { count: { $gt: 10 } } },
    { $sort: { count: -1, lastLogin: -1 } },
    { $lookup: { from: "users", localField: "_id", foreignField: "_id", as: "user", pipeline: [{ $project: { fullName: 1, email: 1 } }] } },
    { $unwind: "$user" },
    { $project: { count: 1, lastLogin: 1, "user.fullName": 1, "user.email": 1 } },
  ]);
}

export async function listAudit(query: unknown, devices = false) {
  const { page, limit } = pageQuery.parse(query);
  const filter = devices ? { action: { $in: ["auth.other_device", "auth.other_device_blocked"] } } : {};
  const [rows, total] = await Promise.all([
    AuditLog.find(filter).select(fields.audit).sort({ timestamp: -1, _id: -1 })
      .populate("actor", "fullName").skip((page - 1) * limit).limit(limit).lean(),
    AuditLog.countDocuments(filter),
  ]);
  return pageResult(rows, total, page, limit);
}
