import {
  Package,
  PackageSubject,
  Subject,
  Term,
  Lecture,
  Material,
  PackageAccess,
  LectureProgress,
  StaffAssignment,
} from "../domain/models.js";
import { packageSchema, packageSubjectSchema } from "../domain/validation.js";
import { placement, activeTerm } from "../academics/service.js";
import { ensure } from "../../shared/errors.js";
import { transaction } from "../../shared/database.js";
import { audit } from "../audit/service.js";
import {
  assignedSubjects,
  contentPermission,
  type Principal,
} from "../staff-assignments/service.js";
export async function studentPackage(
  user: Principal,
  packageId: unknown,
  owned = true,
) {
  const pkg = await Package.findById(packageId);
  ensure(pkg, 404, "NOT_FOUND");
  if (owned)
    ensure(
      await PackageAccess.exists({
        studentId: user.userId,
        packageId,
        status: "active",
      }),
      403,
      "PACKAGE_ACCESS_REQUIRED",
    );
  else {
    const term = await activeTerm(user.collegeId, user.academicYearId);
    ensure(
      pkg.status === "active" &&
        String(pkg.collegeId) === user.collegeId &&
        String(pkg.academicYearId) === user.academicYearId &&
        String(pkg.termId) === String(term._id),
      403,
      "INELIGIBLE_PACKAGE",
    );
    ensure(await hasActiveSubjects(pkg._id), 403, "INELIGIBLE_PACKAGE");
  }
  return pkg;
}
export async function hasActiveSubjects(packageId: unknown) {
  const ids = await Subject.find({ status: "active" }).distinct("_id");
  return PackageSubject.exists({
    packageId,
    status: "active",
    subjectId: { $in: ids },
  });
}
export async function savePackage(
  actor: unknown,
  body: unknown,
  entityId?: string,
) {
  const data = packageSchema.parse(body);
  const { subjectIds, ...packageData } = data;
  await placement(data.collegeId, data.academicYearId);
  ensure(
    await Term.exists({
      _id: data.termId,
      academicYearId: data.academicYearId,
      status: { $ne: "archived" },
    }),
    400,
    "INVALID_TERM",
  );
  return transaction(async (session) => {
    if (subjectIds) {
      const matching = await Subject.countDocuments({
        _id: { $in: subjectIds },
        collegeId: data.collegeId,
        academicYearId: data.academicYearId,
        termId: data.termId,
        status: "active",
      }).session(session);
      ensure(matching === subjectIds.length, 400, "INVALID_SUBJECT_CONTEXT");
    }
    const existing = entityId
      ? await Package.findById(entityId).session(session)
      : null;
    if (entityId) ensure(existing, 404, "NOT_FOUND");
    if (existing)
      for (const field of ["collegeId", "academicYearId", "termId"] as const)
        ensure(
          String(existing.get(field)) === data[field],
          409,
          "PARENT_IMMUTABLE",
        );
    const record = existing
      ? await existing.set(packageData).save({ session })
      : (await Package.create([packageData], { session }))[0]!;
    if (subjectIds) {
      await PackageSubject.updateMany(
        { packageId: record._id, subjectId: { $nin: subjectIds } },
        { $set: { status: "archived" } },
        { session },
      );
      for (const [order, subjectId] of subjectIds.entries()) {
        await PackageSubject.findOneAndUpdate(
          { packageId: record._id, subjectId },
          { $set: { order, status: "active" } },
          { upsert: true, new: true, runValidators: true, session },
        );
      }
    }
    await audit(
      actor,
      existing ? "package.updated" : "package.created",
      "packages",
      record._id,
      {},
      session,
    );
    return record;
  });
}
export async function addSubject(
  actor: unknown,
  packageId: string,
  body: unknown,
) {
  const data = packageSubjectSchema.parse(body),
    pkg = await Package.findById(packageId),
    subject = await Subject.findById(data.subjectId);
  ensure(
    pkg &&
      subject &&
      subject.status === "active" &&
      String(pkg.collegeId) === String(subject.collegeId) &&
      (!subject.academicYearId ||
        String(pkg.academicYearId) === String(subject.academicYearId)) &&
      (!subject.termId || String(pkg.termId) === String(subject.termId)),
    400,
    "INVALID_SUBJECT_CONTEXT",
  );
  return transaction(async (session) => {
    const row = await PackageSubject.findOneAndUpdate(
      { packageId, subjectId: data.subjectId },
      { $set: data },
      { upsert: true, new: true, runValidators: true, session },
    );
    await audit(
      actor,
      "package.subject_added",
      "package_subjects",
      row._id,
      {},
      session,
    );
    return row;
  });
}
export async function listPackages(user: Principal, mode: string) {
  let filter: Record<string, unknown> = {};
  if (user.role === "student") {
    const access = await PackageAccess.find({
      studentId: user.userId,
      status: "active",
    }).lean();
    const owned = access.map((a) => a.packageId);
    if (mode === "explore") {
      const term = await activeTerm(user.collegeId, user.academicYearId);
      filter = {
        collegeId: user.collegeId,
        academicYearId: user.academicYearId,
        termId: term._id,
        status: "active",
        _id: { $nin: owned },
      };
    } else filter = { _id: { $in: owned } };
  } else if (user.role !== "super_admin") {
    const assignments = await StaffAssignment.find({
      userId: user.userId,
      active: true,
      permissions: "content:view",
    })
      .select("packageId")
      .lean();
    filter = { _id: { $in: assignments.map((a) => a.packageId) } };
  }
  const packages = await Package.find(filter).sort({ createdAt: -1 }).lean();
  const subjects = await PackageSubject.find({
    packageId: { $in: packages.map((p) => p._id) },
    status: "active",
  })
    .populate("subjectId", "name description status")
    .sort({ order: 1 })
    .lean();
  const result = [];
  for (const pkg of packages) {
    let ps = subjects.filter((s) => String(s.packageId) === String(pkg._id));
    if (user.role === "student") {
      ps = ps.filter((s) => s.subjectId?.status === "active");
      if (mode === "explore" && ps.length === 0) continue;
    }
    if (user.role !== "student" && user.role !== "super_admin") {
      const allowed = await assignedSubjects(user);
      ps = ps.filter((s) =>
        allowed.some((a) => String(a._id) === String(s._id)),
      );
    }
    let progress: unknown = undefined;
    if (user.role === "student" && mode !== "explore") {
      const lectures = await Lecture.find({
        packageSubjectId: { $in: ps.map((s) => s._id) },
        status: "published",
        publishedAt: { $lte: new Date() },
      })
        .select("_id")
        .lean();
      const completed = await LectureProgress.countDocuments({
        studentId: user.userId,
        lectureId: { $in: lectures.map((l) => l._id) },
      });
      progress = { completed, total: lectures.length };
    }
    result.push({ ...pkg, subjects: ps, progress });
  }
  return result;
}
export async function packageDetail(
  user: Principal,
  packageId: string,
  preview = false,
) {
  const pkg =
    user.role === "student"
      ? await studentPackage(user, packageId, !preview)
      : await Package.findById(packageId);
  ensure(pkg, 404, "NOT_FOUND");
  let subjects = await PackageSubject.find({
    packageId,
    ...(user.role === "student" ? { status: "active" } : {}),
  })
    .populate("subjectId", "name description status")
    .sort({ order: 1 })
    .lean();
  if (user.role === "student")
    subjects = subjects.filter((s) => s.subjectId?.status === "active");
  if (user.role !== "student" && user.role !== "super_admin") {
    const allowed = await assignedSubjects(user);
    subjects = subjects.filter((s) =>
      allowed.some((a) => String(a._id) === String(s._id)),
    );
    const packageAssignment = await StaffAssignment.exists({
      userId: user.userId,
      packageId,
      scopeType: "package",
      active: true,
      permissions: "content:view",
    });
    ensure(
      subjects.length || packageAssignment,
      403,
      "CONTENT_PERMISSION_DENIED",
    );
  }
  const lectureFilter = {
    packageSubjectId: { $in: subjects.map((s) => s._id) },
    ...(user.role === "student"
      ? { status: "published", publishedAt: { $lte: new Date() } }
      : {}),
  };
  const lectures = preview
    ? []
    : await Lecture.find(lectureFilter).sort({ order: 1 }).lean();
  const progress =
    user.role === "student" && !preview
      ? await LectureProgress.find({
          studentId: user.userId,
          lectureId: { $in: lectures.map((l) => l._id) },
        }).lean()
      : [];
  const assignments = await StaffAssignment.find({ packageId, active: true })
    .populate("userId", "fullName role")
    .lean();
  return {
    package: pkg,
    subjects: subjects.map((s) => ({
      ...s,
      lecturers: assignments
        .filter(
          (a) =>
            a.scopeType === "package_subject" &&
            String(a.packageSubjectId) === String(s._id) &&
            a.userId &&
            a.userId.role === "lecturer",
        )
        .map((a) => a.userId),
    })),
    lectures: lectures.map((l) => ({
      ...l,
      completed: progress.some((p) => String(p.lectureId) === String(l._id)),
    })),
    permissions:
      user.role === "super_admin"
        ? [
            "content:view",
            "content:create",
            "content:edit",
            "content:delete_draft",
            "content:publish",
            "content:archive",
          ]
        : assignments
            .filter((a) => String(a.userId?._id) === user.userId)
            .map((a) => ({
              scopeType: a.scopeType,
              packageSubjectId: a.packageSubjectId,
              permissions: a.permissions,
            })),
  };
}
export async function lectureDetail(user: Principal, lectureId: string) {
  const lecture = await Lecture.findById(lectureId);
  ensure(lecture, 404, "NOT_FOUND");
  const subject = await PackageSubject.findById(
    lecture.packageSubjectId,
  ).populate("subjectId", "name status");
  ensure(subject, 404, "NOT_FOUND");
  if (user.role === "student") {
    await studentPackage(user, subject.packageId);
    ensure(
      subject.status === "active" &&
        subject.subjectId?.status === "active" &&
        lecture.status === "published" &&
        lecture.publishedAt &&
        new Date(lecture.publishedAt).getTime() <= Date.now(),
      404,
      "NOT_FOUND",
    );
  } else
    await contentPermission(
      user,
      subject.packageId,
      subject._id,
      "content:view",
    );
  return {
    lecture,
    subject,
    package: await Package.findById(subject.packageId).select("name"),
    materials: await Material.find({ lectureId }).sort({ order: 1 }).lean(),
    completed: !!(await LectureProgress.exists({
      studentId: user.userId,
      lectureId,
    })),
  };
}
