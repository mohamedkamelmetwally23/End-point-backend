import { dto, fields } from "../../shared/dto.js";
import {
  LectureProgress,
  Lecture,
  PackageSubject,
  PackageAccess,
} from "../domain/models.js";
import { accessibleLecture } from "../packages/service.js";
import type { Principal } from "../staff-assignments/service.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
export async function completeLecture(user: Principal, lectureId: string) {
  const detail = await accessibleLecture(user, lectureId);
  return transaction(async (session) => {
    const existing = await LectureProgress.findOne({
      studentId: user.userId,
      lectureId,
    }).session(session);
    if (existing) return dto(existing, "_id lectureId completedAt");
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
    return dto(record, "_id lectureId completedAt");
  });
}
export async function timeline(user: Principal, from: string, to: string) {
  const access = await PackageAccess.find({
    studentId: user.userId,
    status: "active",
  }).select("packageId").lean();
  const subjects = await PackageSubject.find({
    packageId: { $in: access.map((a) => a.packageId) },
    status: "active",
  })
    .select(fields.subject)
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
    .select("_id packageSubjectId title publishedAt")
    .sort({ publishedAt: 1 })
    .lean();
  const contexts = new Map(subjects.map(s => [String(s._id), s]));
  return lectures.map(l => {
    const subject = contexts.get(String(l.packageSubjectId));
    return {
      _id: l._id, packageSubjectId: l.packageSubjectId, title: l.title, publishedAt: l.publishedAt,
      context: subject ? { subjectId: { name: subject.subjectId?.name }, packageId: { name: subject.packageId?.name } } : undefined,
    };
  });
}
