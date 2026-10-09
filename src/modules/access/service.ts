import type { ClientSession } from "mongoose";
import {
  PackageAccess,
  User,
  Package,
  Session,
  StudentDevice,
} from "../domain/models.js";
import { studentPackage } from "../packages/service.js";
import type { Principal } from "../staff-assignments/service.js";
import { ensure } from "../../shared/errors.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
export async function grant(
  studentId: unknown,
  packageId: unknown,
  source: string,
  actor: unknown,
  session: ClientSession,
) {
  ensure(
    await User.exists({ _id: studentId, role: "student" }).session(session),
    400,
    "INVALID_STUDENT",
  );
  ensure(
    await Package.exists({ _id: packageId }).session(session),
    400,
    "INVALID_PACKAGE",
  );
  const current = await PackageAccess.findOne({ studentId, packageId }).session(
    session,
  );
  if (current?.status === "active") return current;
  const access = await PackageAccess.findOneAndUpdate(
    { studentId, packageId },
    {
      $set: {
        source,
        status: "active",
        grantedAt: new Date(),
        grantedBy: actor,
      },
      $unset: { revokedAt: 1, revokedBy: 1 },
    },
    { new: true, upsert: true, runValidators: true, session },
  );
  await audit(
    actor,
    "access.granted",
    "package_access",
    access._id,
    { source },
    session,
  );
  return access;
}
export async function claim(user: Principal, packageId: string) {
  const pkg = await studentPackage(user, packageId, false);
  ensure(pkg.isFree, 400, "NOT_FREE");
  return transaction((session) =>
    grant(user.userId, packageId, "free", user.userId, session),
  );
}
export async function manualAccess(
  actor: unknown,
  studentId: string,
  packageId: string,
  revoke = false,
) {
  return transaction(async (session) => {
    if (!revoke) return grant(studentId, packageId, "manual", actor, session);
    const row = await PackageAccess.findOneAndUpdate(
      { studentId, packageId, status: "active" },
      { $set: { status: "revoked", revokedAt: new Date(), revokedBy: actor } },
      { new: true, session },
    );
    ensure(row, 404, "NOT_FOUND");
    await audit(
      actor,
      "access.revoked",
      "package_access",
      row._id,
      {},
      session,
    );
    return row;
  });
}
export async function resetDevice(actor: unknown, studentId: string) {
  ensure(
    await User.exists({ _id: studentId, role: "student" }),
    400,
    "INVALID_STUDENT",
  );
  await transaction(async (session) => {
    await StudentDevice.deleteMany({ studentId }).session(session);
    await Session.deleteMany({ userId: studentId }).session(session);
    await audit(actor, "student.device_reset", "users", studentId, {}, session);
  });
}
