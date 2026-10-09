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
