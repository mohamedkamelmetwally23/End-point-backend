import {
  LectureProgress,
  Lecture,
  PackageSubject,
  PackageAccess,
} from "../domain/models.js";
import { lectureDetail } from "../packages/service.js";
import type { Principal } from "../staff-assignments/service.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
export async function completeLecture(user: Principal, lectureId: string) {
  const detail = await lectureDetail(user, lectureId);
  return transaction(async (session) => {
    const existing = await LectureProgress.findOne({
      studentId: user.userId,
      lectureId,
    }).session(session);
    if (existing) return existing;
    const record = (
      await LectureProgress.create(
        [
          {
            studentId: user.userId,
            lectureId,
            packageId: detail.subject.packageId,
            packageSubjectId: detail.subject._id,
            completedAt: new Date(),
          },
        ],
        { session },
      )
    )[0]!;
    await audit(
      user.userId,
      "lecture.completed",
      "lecture_progress",
      record._id,
      {},
      session,
    );
    return record;
  });
}
export async function timeline(user: Principal, from: string, to: string) {
  const access = await PackageAccess.find({
    studentId: user.userId,
    status: "active",
  }).lean();
  const subjects = await PackageSubject.find({
    packageId: { $in: access.map((a) => a.packageId) },
    status: "active",
  })
    .populate("subjectId", "name status")
    .populate("packageId", "name")
    .lean();
  const lectures = await Lecture.find({
    packageSubjectId: {
      $in: subjects
        .filter((s) => s.subjectId?.status === "active")
        .map((s) => s._id),
    },
    status: "published",
    publishedAt: { $gte: new Date(from), $lt: new Date(to), $lte: new Date() },
  })
    .sort({ publishedAt: 1 })
    .lean();
  return lectures.map((l) => ({
    ...l,
    context: subjects.find((s) => String(s._id) === String(l.packageSubjectId)),
  }));
}
