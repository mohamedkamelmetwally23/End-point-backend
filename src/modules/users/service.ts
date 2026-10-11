import { pageQuery, pageResult } from "../../shared/pagination.js";
import { dto, fields } from "../../shared/dto.js";
import bcrypt from "bcryptjs";
import { z } from "zod";
import {
  User,
  Session,
  PackageAccess,
  Lecture,
  LectureProgress,
  StaffAssignment,
  Package,
  Order,
  AuditLog,
} from "../domain/models.js";
import { staffSchema, id } from "../domain/validation.js";
import { placement } from "../academics/service.js";
import {
  assignedSubjects,
  type Principal,
} from "../staff-assignments/service.js";
import { finance } from "../finance/service.js";
import { ensure } from "../../shared/errors.js";
import { transaction } from "../../shared/database.js";
import { audit } from "../audit/service.js";
export async function createStaff(actor: unknown, body: unknown) {
  const { password, ...data } = staffSchema.parse(body);
  return transaction(async (session) => {
    const user = (
      await User.create(
        [{ ...data, passwordHash: await bcrypt.hash(password, 12) }],
        { session },
      )
    )[0]!;
    await audit(actor, "user.created", "users", user._id, {}, session);
    return User.findById(user._id).select(fields.user).session(session).lean();
  });
}
export async function updateUser(
  actor: unknown,
  userId: string,
  body: unknown,
) {
  const data = z
    .object({
      fullName: z.string().trim().min(2).max(160).optional(),
      phone: z.string().max(30).optional(),
      status: z.enum(["active", "disabled"]).optional(),
      collegeId: id.optional(),
      academicYearId: id.optional(),
    })
    .parse(body);
  const user = await User.findById(userId);
  ensure(user, 404, "NOT_FOUND");
  ensure(
    !(String(actor) === userId && data.status === "disabled"),
    409,
    "CANNOT_DISABLE_SELF",
  );
  if (data.collegeId || data.academicYearId) {
    ensure(
      user.role === "student" && data.collegeId && data.academicYearId,
      400,
      "INVALID_PLACEMENT",
    );
    await placement(data.collegeId, data.academicYearId);
  }
  return transaction(async (session) => {
    await user.set(data).save({ session });
    if (data.status === "disabled")
      await Session.deleteMany({ userId }).session(session);
    await audit(
      actor,
      data.status === "disabled" ? "user.disabled" : "user.updated",
      "users",
      userId,
      {},
      session,
    );
    return dto(user, fields.user);
  });
}
export async function lecturerStudents(user: Principal, query: unknown = {}) {
  const { page, limit } = pageQuery.parse(query);
  const subjects = await assignedSubjects(user),
    packageIds = subjects.map((s) => s.packageId);
  const accessFilter = { packageId: { $in: packageIds }, status: "active" };
  const total = await PackageAccess.countDocuments(accessFilter);
  const accesses = await PackageAccess.find(accessFilter)
    .select("studentId packageId")
    .sort({ _id: 1 }).skip((page - 1) * limit).limit(limit)
    .populate("studentId", "fullName email phone")
    .populate("packageId", "name")
    .lean();
  const lectures = await Lecture.find({
    packageSubjectId: { $in: subjects.map((s) => s._id) },
    status: "published",
    publishedAt: { $lte: new Date() },
  }).select("_id packageSubjectId title").lean();
  const progress = await LectureProgress.find({
    studentId: { $in: accesses.map((a) => a.studentId?._id) },
    lectureId: { $in: lectures.map((l) => l._id) },
  }).select("studentId lectureId completedAt").lean();
  const lecturesBySubject = new Map<string, typeof lectures>();
  for (const lecture of lectures) {
    const key = String(lecture.packageSubjectId);
    const rows = lecturesBySubject.get(key) ?? [];
    rows.push(lecture); lecturesBySubject.set(key, rows);
  }
  const progressByStudent = new Map<string, Map<string, typeof progress[number]>>();
  for (const item of progress) {
    const key = String(item.studentId);
    const rows = progressByStudent.get(key) ?? new Map();
    rows.set(String(item.lectureId), item); progressByStudent.set(key, rows);
  }
  const rows = accesses.filter(a => a.studentId).flatMap(a =>
    subjects.filter(s => String(s.packageId) === String(a.packageId?._id)).map(s => {
      const relevant = lecturesBySubject.get(String(s._id)) ?? [];
      const completedByLecture = progressByStudent.get(String(a.studentId._id));
      const completed = relevant.flatMap(l => {
        const item = completedByLecture?.get(String(l._id));
        return item ? [item] : [];
      });
      return {
        student: a.studentId, package: a.packageId, packageSubjectId: s._id,
        completed: completed.length, total: relevant.length,
        lastActivity: completed.map(p => p.completedAt).sort().at(-1),
        lectures: relevant.map(l => ({ _id: l._id, title: l.title, completed: completedByLecture?.has(String(l._id)) ?? false })),
      };
    }));
  // A page contains enrollments; each enrollment can have several subject rows.
  return pageResult(rows, total, page, limit);
}
export async function dashboard(user: Principal) {
  if (user.role === "super_admin") {
    const [
      students,
      lecturers,
      contentManagers,
      activePackages,
      pendingOrders,
      completedOrders,
      accounts,
      activity,
    ] = await Promise.all([
      User.countDocuments({ role: "student" }),
      User.countDocuments({ role: "lecturer" }),
      User.countDocuments({ role: "content_manager" }),
      Package.countDocuments({ status: "active" }),
      Order.countDocuments({ status: "pending" }),
      Order.countDocuments({ status: "completed" }),
      finance(user, {}, true),
      AuditLog.find().select(fields.audit)
        .sort({ timestamp: -1 })
        .limit(8)
        .populate("actor", "fullName")
        .lean(),
    ]);
    return {
      stats: {
        students,
        lecturers,
        contentManagers,
        activePackages,
        pendingOrders,
        completedOrders,
        revenue: accounts.revenue,
        expenseTotal: accounts.expenseTotal,
        netProfit: accounts.netProfit,
      },
      activity,
      accounts: { monthlyExpenses: accounts.monthlyExpenses, monthlyRevenue: accounts.monthlyRevenue },
    };
  }
  const subjects = await assignedSubjects(user);
  const packageIds = await StaffAssignment.distinct("packageId", {
    userId: user.userId,
    active: true,
    permissions: "content:view",
  });
  const [totalLectures, draftLectures, publishedLectures, totalStudents] =
    await Promise.all([
      Lecture.countDocuments({
        packageSubjectId: { $in: subjects.map((s) => s._id) },
      }),
      Lecture.countDocuments({
        packageSubjectId: { $in: subjects.map((s) => s._id) },
        status: "draft",
      }),
      Lecture.countDocuments({
        packageSubjectId: { $in: subjects.map((s) => s._id) },
        status: "published",
      }),
      PackageAccess.distinct("studentId", {
        packageId: { $in: packageIds },
        status: "active",
      }),
    ]);
  return {
    stats: {
      assignedPackages: packageIds.length,
      assignedSubjects: subjects.length,
      totalLectures,
      draftLectures,
      publishedLectures,
      totalStudents: totalStudents.length,
    },
    activity: await AuditLog.find({ actor: user.userId }).select(fields.audit)
      .sort({ timestamp: -1 })
      .limit(8)
      .lean(),
  };
}
export async function studentInspection(userId: string) {
  const user = await User.findOne({ _id: userId, role: "student" })
    .select(fields.user)
    .populate("collegeId", "name")
    .populate("academicYearId", "name")
    .lean();
  ensure(user, 404, "NOT_FOUND");
  return {
    user,
    access: await PackageAccess.find({ studentId: userId }).select("_id packageId status")
      .populate("packageId", "name")
      .lean(),

  };
}

export async function listUsers(role: string, query: unknown) {
  const { page, limit } = pageQuery.parse(query);
  const filter = { role };
  const [rows, total] = await Promise.all([
    User.find(filter).select(fields.user).populate("collegeId", "name")
      .populate("academicYearId", "name").sort({ createdAt: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    User.countDocuments(filter),
  ]);
  return pageResult(rows, total, page, limit);
}
