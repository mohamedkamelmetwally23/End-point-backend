import {
  Lecture,
  Material,
  PackageSubject,
  LectureProgress,
} from "../domain/models.js";
import { lectureSchema, materialSchema } from "../domain/validation.js";
import {
  contentPermission,
  type Principal,
} from "../staff-assignments/service.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
import { ensure } from "../../shared/errors.js";
export async function saveLecture(
  user: Principal,
  body: unknown,
  entityId?: string,
) {
  const data = lectureSchema.parse(body),
    subject = await PackageSubject.findById(data.packageSubjectId);
  ensure(subject, 400, "INVALID_PACKAGE_SUBJECT");
  const existing = entityId ? await Lecture.findById(entityId) : null;
  if (entityId) ensure(existing, 404, "NOT_FOUND");
  if (existing)
    ensure(
      String(existing.packageSubjectId) === data.packageSubjectId,
      409,
      "PARENT_IMMUTABLE",
    );
  await contentPermission(
    user,
    subject.packageId,
    subject._id,
    existing ? "content:edit" : "content:create",
  );
  if (
    ["scheduled", "published"].includes(data.status) ||
    ["scheduled", "published"].includes(String(existing?.status))
  )
    await contentPermission(
      user,
      subject.packageId,
      subject._id,
      "content:publish",
    );
  if (data.status === "archived")
    await contentPermission(
      user,
      subject.packageId,
      subject._id,
      "content:archive",
    );
  return transaction(async (session) => {
    const fields = {
      ...data,
      updatedBy: user.userId,
      ...(data.status === "published"
        ? { publishedAt: existing?.publishedAt ?? new Date() }
        : data.status === "scheduled"
          ? { publishedAt: undefined }
          : {}),
    };
    const row = existing
      ? await existing.set(fields).save({ session })
      : (
          await Lecture.create([{ ...fields, createdBy: user.userId }], {
            session,
          })
        )[0]!;
    await audit(
      user.userId,
      `lecture.${existing ? "updated" : "created"}.${data.status}`,
      "lectures",
      row._id,
      {},
      session,
    );
    return row;
  });
}
export async function saveMaterial(
  user: Principal,
  body: unknown,
  entityId?: string,
) {
  const data = materialSchema.parse(body),
    lecture = await Lecture.findById(data.lectureId);
  ensure(lecture, 400, "INVALID_LECTURE");
  const subject = await PackageSubject.findById(lecture.packageSubjectId);
  ensure(subject, 400, "INVALID_PACKAGE_SUBJECT");
  await contentPermission(
    user,
    subject.packageId,
    subject._id,
    entityId ? "content:edit" : "content:create",
  );
  if (lecture.status === "published" || lecture.status === "scheduled")
    await contentPermission(
      user,
      subject.packageId,
      subject._id,
      "content:publish",
    );
  return transaction(async (session) => {
    const row = entityId
      ? await Material.findOne({
          _id: entityId,
          lectureId: data.lectureId,
        }).session(session)
      : null;
    if (entityId) ensure(row, 404, "NOT_FOUND");
    const fields = {
      ...data,
      url: data.type === "text" ? undefined : data.url,
      body: data.type === "text" ? data.body : undefined,
    };
    const record = row
      ? await row.set(fields).save({ session })
      : (await Material.create([fields], { session }))[0]!;
    await audit(
      user.userId,
      row ? "material.updated" : "material.created",
      "materials",
      record._id,
      {},
      session,
    );
    return record;
  });
}
export async function deleteDraft(
  user: Principal,
  kind: "lectures" | "materials",
  entityId: string,
) {
  const row = await (kind === "lectures" ? Lecture : Material).findById(
    entityId,
  );
  ensure(row, 404, "NOT_FOUND");
  const lecture =
    kind === "lectures" ? row : await Lecture.findById(row.lectureId);
  ensure(
    lecture &&
      lecture.status === "draft" &&
      !lecture.publishedAt &&
      !(await LectureProgress.exists({ lectureId: lecture._id })),
    409,
    "ONLY_UNUSED_DRAFT_DELETION",
  );
  const subject = await PackageSubject.findById(lecture.packageSubjectId);
  ensure(subject, 404, "NOT_FOUND");
  await contentPermission(
    user,
    subject.packageId,
    subject._id,
    "content:delete_draft",
  );
  await transaction(async (session) => {
    if (kind === "lectures")
      await Material.deleteMany({ lectureId: entityId }).session(session);
    await row.deleteOne({ session });
    await audit(
      user.userId,
      "content.draft_deleted",
      kind,
      entityId,
      {},
      session,
    );
  });
}
export async function publishScheduled() {
  const due = await Lecture.find({
    status: "scheduled",
    scheduledAt: { $lte: new Date() },
  }).select("_id");
  for (const item of due)
    await transaction(async (session) => {
      const row = await Lecture.findOneAndUpdate(
        {
          _id: item._id,
          status: "scheduled",
          scheduledAt: { $lte: new Date() },
        },
        [
          {
            $set: {
              status: "published",
              publishedAt: "$scheduledAt",
              updatedAt: new Date(),
            },
          },
        ],
        { new: true, session },
      );
      if (row)
        await audit(
          row.updatedBy,
          "lecture.published",
          "lectures",
          row._id,
          { scheduled: true },
          session,
        );
    });
}
