import {
  StaffAssignment,
  PackageSubject,
  Package,
  User,
} from "../domain/models.js";
import { assignmentSchema } from "../domain/validation.js";
import { ensure } from "../../shared/errors.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
export type Principal = {
  userId: string;
  role: string;
  collegeId?: string;
  academicYearId?: string;
};
export async function contentPermission(
  user: Principal,
  packageId: unknown,
  packageSubjectId: unknown,
  permission: string,
) {
  if (user.role === "super_admin") return;
  ensure(["lecturer", "content_manager"].includes(user.role), 403, "FORBIDDEN");
  const assignment = await StaffAssignment.exists({
    userId: user.userId,
    active: true,
    packageId,
    permissions: permission,
    $or: [
      { scopeType: "package" },
      { scopeType: "package_subject", packageSubjectId },
    ],
  });
  ensure(assignment, 403, "CONTENT_PERMISSION_DENIED");
}
export async function assignedSubjects(user: Principal) {
  if (user.role === "super_admin")
    return PackageSubject.find({ status: "active" }).lean();
  const assignments = await StaffAssignment.find({
    userId: user.userId,
    active: true,
    permissions: "content:view",
  }).lean();
  const packageIds = assignments
    .filter((a) => a.scopeType === "package")
    .map((a) => a.packageId);
  const subjectIds = assignments
    .filter((a) => a.scopeType === "package_subject")
    .map((a) => a.packageSubjectId);
  return PackageSubject.find({
    status: "active",
    $or: [{ packageId: { $in: packageIds } }, { _id: { $in: subjectIds } }],
  }).lean();
}
export async function saveAssignment(actor: unknown, body: unknown) {
  const data = assignmentSchema.parse(body);
  const user = await User.findById(data.userId);
  ensure(
    user && ["lecturer", "content_manager"].includes(String(user.role)),
    400,
    "INVALID_STAFF",
  );
  ensure(
    user.role !== "lecturer" || data.scopeType === "package_subject",
    400,
    "LECTURER_SUBJECT_SCOPE_REQUIRED",
  );
  ensure(await Package.exists({ _id: data.packageId }), 400, "INVALID_PACKAGE");
  if (data.packageSubjectId)
    ensure(
      await PackageSubject.exists({
        _id: data.packageSubjectId,
        packageId: data.packageId,
      }),
      400,
      "INVALID_PACKAGE_SUBJECT",
    );
  return transaction(async (session) => {
    const assignment = await StaffAssignment.findOneAndUpdate(
      {
        userId: data.userId,
        scopeType: data.scopeType,
        packageId: data.packageId,
        packageSubjectId: data.packageSubjectId ?? null,
      },
      { $set: data },
      { upsert: true, new: true, runValidators: true, session },
    );
    await audit(
      actor,
      "staff.permissions_changed",
      "staff_assignments",
      assignment._id,
      {},
      session,
    );
    return assignment;
  });
}
