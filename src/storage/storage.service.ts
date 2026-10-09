import { randomUUID } from "node:crypto";
import type { Request } from "express";
import { Schema, model, type ClientSession } from "mongoose";
import { z } from "zod";
import { ensure, ApiError } from "../shared/errors.js";
import {
  Lecture,
  Material,
  PackageSubject,
  Expense,
  Package,
  Order,
} from "../modules/domain/models.js";
import {
  contentPermission,
  type Principal,
} from "../modules/staff-assignments/service.js";
import { lectureDetail } from "../modules/packages/service.js";
import { blobProvider, type Visibility } from "./vercel-blob.provider.js";

export const StoredFile = model(
  "stored_files",
  new Schema(
    {
      storageProvider: {
        type: String,
        enum: ["vercel-blob"],
        default: "vercel-blob",
        required: true,
      },
      pathname: { type: String, required: true, unique: true },
      blobUrl: String,
      originalName: { type: String, required: true },
      mimeType: { type: String, required: true },
      size: { type: Number, required: true },
      uploadedBy: { type: Schema.Types.ObjectId, required: true },
      purpose: {
        type: String,
        enum: ["summary", "material", "receipt", "cover"],
        required: true,
      },
      scopeId: String,
      visibility: { type: String, enum: ["public", "private"], required: true },
      status: {
        type: String,
        enum: ["pending", "ready", "deleting"],
        default: "pending",
      },
      references: { type: Number, default: 0 },
    },
    { timestamps: true, strict: "throw" },
  ),
);
const mimes = {
  "application/pdf": "pdf",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
const input = z.object({
  originalName: z.string().min(1).max(200),
  mimeType: z.enum([
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/webp",
  ]),
  size: z.number().int().positive(),
  purpose: z.enum(["summary", "material", "receipt", "cover"]),
  scopeId: z
    .string()
    .regex(/^[a-f\d]{24}$/i)
    .optional(),
  editing: z.boolean().default(false),
});
export function fileReference(file: {
  _id: unknown;
  mimeType: string;
  visibility: string;
  blobUrl?: string | null;
}) {
  return file.visibility === "public"
    ? file.blobUrl!
    : `/api/v1/files/${file._id}.${mimes[file.mimeType as keyof typeof mimes]}`;
}
export function fileId(value: unknown) {
  return typeof value === "string"
    ? /^\/api\/v1\/files\/([a-f\d]{24})\.(?:pdf|png|jpg|webp)$/.exec(value)?.[1]
    : undefined;
}
export function validSignature(bytes: Buffer, mime: string) {
  if (mime === "application/pdf")
    return bytes.toString("ascii", 0, 5) === "%PDF-";
  if (mime === "image/png")
    return bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === "image/jpeg")
    return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return (
    mime === "image/webp" &&
    bytes.toString("ascii", 0, 4) === "RIFF" &&
    bytes.toString("ascii", 8, 12) === "WEBP"
  );
}
export async function uploadPermission(
  user: Principal,
  purpose: string,
  scopeId: string | undefined,
  editing = false,
) {
  ensure(
    ["super_admin", "content_manager", "lecturer"].includes(user.role),
    403,
    "FILE_ACCESS_DENIED",
  );
  if (purpose === "cover") {
    ensure(user.role === "super_admin", 403, "FILE_ACCESS_DENIED");
    return;
  }
  if (purpose === "receipt") return;
  let subject;
  if (purpose === "material") {
    const lecture = await Lecture.findById(scopeId);
    ensure(lecture, 404, "INVALID_LECTURE");
    subject = await PackageSubject.findById(lecture.packageSubjectId);
    if (["published", "scheduled"].includes(String(lecture.status)) && subject)
      await contentPermission(
        user,
        subject.packageId,
        subject._id,
        "content:publish",
      );
  } else subject = await PackageSubject.findById(scopeId);
  ensure(subject, 400, "INVALID_PACKAGE_SUBJECT");
  await contentPermission(
    user,
    subject.packageId,
    subject._id,
    editing ? "content:edit" : "content:create",
  );
}
export async function prepareUpload(user: Principal, body: unknown) {
  const data = input.parse(body);
  ensure(
    data.size <= (data.mimeType === "application/pdf" ? 20 : 2) * 1024 * 1024,
    400,
    "FILE_TOO_LARGE",
  );
  ensure(
    data.purpose !== "summary" || data.mimeType === "application/pdf",
    400,
    "INVALID_FILE_TYPE",
  );
  ensure(
    !["receipt", "cover"].includes(data.purpose) ||
      data.mimeType.startsWith("image/"),
    400,
    "INVALID_FILE_TYPE",
  );
  await uploadPermission(user, data.purpose, data.scopeId, data.editing);
  const { editing: _editing, ...metadata } = data;
  const file = await StoredFile.create({
    ...metadata,
    uploadedBy: user.userId,
    pathname: `endpoint/${data.purpose}/${randomUUID()}.${mimes[data.mimeType]}`,
    visibility: data.purpose === "cover" ? "public" : "private",
  });
  return {
    id: String(file._id),
    pathname: file.pathname,
    access: file.visibility,
  };
}
export async function ownedPending(user: Principal, id: string) {
  const file = await StoredFile.findById(id);
  ensure(
    file &&
      String(file.uploadedBy) === user.userId &&
      file.status === "pending" &&
      Date.now() - file.createdAt!.getTime() < 15 * 60000,
    403,
    "FILE_ACCESS_DENIED",
  );
  return file;
}
export async function completeUpload(user: Principal, id: string) {
  const file = await ownedPending(user, id);
  try {
    const metadata = await blobProvider.head(
      file.pathname!,
      file.visibility as Visibility,
    );
    ensure(
      metadata.pathname === file.pathname &&
        metadata.size === file.size &&
        metadata.contentType === file.mimeType,
      400,
      "INVALID_FILE_TYPE",
    );
    const result = await blobProvider.get(
      file.pathname!,
      file.visibility as Visibility,
    );
    ensure(result?.statusCode === 200, 404, "FILE_NOT_FOUND");
    const reader = result.stream.getReader();
    let prefix = Buffer.alloc(0);
    try {
      while (prefix.length < 12) {
        const chunk = await reader.read();
        if (chunk.done) break;
        prefix = Buffer.concat([
          prefix,
          Buffer.from(chunk.value).subarray(0, 12),
        ]);
      }
    } finally {
      await reader.cancel();
    }
    ensure(validSignature(prefix, file.mimeType!), 400, "INVALID_FILE_TYPE");
    file.blobUrl = metadata.url;
    file.status = "ready";
    await file.save();
    return {
      id: String(file._id),
      url: fileReference(file as Parameters<typeof fileReference>[0]),
      originalName: file.originalName,
      mimeType: file.mimeType,
      size: file.size,
      storageProvider: "vercel-blob",
    };
  } catch (error) {
    if (error instanceof ApiError && error.status === 400) {
      try {
        await blobProvider.delete(
          file.pathname!,
          file.visibility as Visibility,
        );
        await StoredFile.deleteOne({ _id: file._id });
      } catch {
        file.status = "deleting";
        await file.save();
      }
    }
    if (error instanceof ApiError) throw error;
    console.error(
      "Storage completion failed",
      error instanceof Error ? error.name : "unknown",
    );
    throw new ApiError(503, "FILE_UPLOAD_FAILED");
  }
}

// Server-generated files use the same provider and verified metadata, never a disk file.
export async function uploadFile(
  user: Principal,
  bytes: Buffer,
  metadata: Omit<z.input<typeof input>, "size">,
) {
  ensure(validSignature(bytes, metadata.mimeType), 400, "INVALID_FILE_TYPE");
  const prepared = await prepareUpload(user, {
    ...metadata,
    size: bytes.length,
  });
  await blobProvider.put(
    prepared.pathname!,
    bytes,
    prepared.access as Visibility,
    metadata.mimeType,
  );
  return completeUpload(user, prepared.id);
}
export async function authorizeUploadRequest(req: Request, id: string) {
  const file = await ownedPending(req.principal, id);
  return blobProvider.authorizeUpload(
    req,
    file.pathname!,
    file.visibility as Visibility,
    file.mimeType!,
    file.size!,
  );
}
export async function createDownloadAccess(user: Principal, id: string) {
  const file = await authorizeDownload(user, id);
  return file.visibility === "public"
    ? file.blobUrl!
    : blobProvider.download(file.pathname!);
}

// Reference counts change in the same transaction as the owning business record.
export async function bindFile(
  user: Principal,
  value: unknown,
  previous: unknown,
  purpose: string,
  scopeId: string | undefined,
  session: ClientSession,
) {
  if (value === previous) return;
  if (typeof value === "string" && value) {
    const query = fileId(value)
      ? { _id: fileId(value) }
      : { blobUrl: value, visibility: "public" };
    const file = await StoredFile.findOne(query).session(session);
    if (fileId(value)) ensure(file, 404, "FILE_NOT_FOUND");
    if (file) {
      ensure(
        file.status === "ready" &&
          file.purpose === purpose &&
          (purpose === "receipt"
            ? String(file.uploadedBy) === user.userId ||
              user.role === "super_admin"
            : file.scopeId === scopeId),
        403,
        "FILE_ACCESS_DENIED",
      );
      ensure(
        value === fileReference(file as Parameters<typeof fileReference>[0]),
        400,
        "INVALID_FILE_REFERENCE",
      );
      file.references = (file.references ?? 0) + 1;
      await file.save({ session });
    }
    ensure(
      (!value.startsWith("data:") &&
        !value.startsWith("blob:") &&
        !value.includes("localhost") &&
        !value.includes("summary-pdfs/") &&
        !value.includes(".blob.vercel-storage.com/")) ||
        !!file,
      400,
      "INVALID_FILE_REFERENCE",
    );
  }
  if (previous)
    await StoredFile.updateOne(
      fileId(previous)
        ? { _id: fileId(previous), references: { $gt: 0 } }
        : { blobUrl: previous, references: { $gt: 0 } },
      { $inc: { references: -1 } },
      { session },
    );
}
export async function protectReferencedFile(
  file: Parameters<typeof fileReference>[0],
) {
  const values = [fileReference(file), ...(file.blobUrl ? [file.blobUrl] : [])];
  const counts = await Promise.all([
    Lecture.countDocuments({ summaryUrl: { $in: values } }),
    Material.countDocuments({ url: { $in: values } }),
    Expense.countDocuments({
      $or: [{ receiptImage: { $in: values } }, { receiptUrl: { $in: values } }],
    }),
    Package.countDocuments({ coverUrl: { $in: values } }),
    Order.countDocuments({ receiptImage: { $in: values } }),
  ]);
  const references = counts.reduce((sum, count) => sum + count, 0);
  if (!references) return false;
  await StoredFile.updateOne(
    { _id: file._id, status: "deleting" },
    { $set: { status: "ready", references } },
  );
  return true;
}
export async function cleanupFile(value: unknown) {
  if (!value) return;
  const file = await StoredFile.findOneAndUpdate(
    fileId(value)
      ? { _id: fileId(value), references: 0, status: "ready" }
      : { blobUrl: value, references: 0, status: "ready" },
    { $set: { status: "deleting" } },
    { new: true },
  );
  if (!file) return;
  try {
    if (
      await protectReferencedFile(file as Parameters<typeof fileReference>[0])
    )
      return;
    await blobProvider.delete(file.pathname!, file.visibility as Visibility);
    await file.deleteOne();
  } catch {
    console.error("Blob cleanup deferred", String(file._id));
  }
}
export async function authorizeDownload(user: Principal, id: string) {
  const file = await StoredFile.findById(id);
  ensure(file?.status === "ready", 404, "FILE_NOT_FOUND");
  if (user.role === "super_admin") return file;
  const reference = fileReference(file as Parameters<typeof fileReference>[0]);
  const lectures = await Lecture.find({ summaryUrl: reference }).select("_id");
  const materials = await Material.find({ url: reference }).select("lectureId");
  for (const item of [
    ...lectures.map((l) => String(l._id)),
    ...materials.map((m) => String(m.lectureId)),
  ]) {
    try {
      await lectureDetail(user, item);
      return file;
    } catch (error) {
      if (!(error instanceof ApiError)) throw error;
    }
  }
  if (
    file.purpose === "receipt" &&
    user.role !== "student" &&
    (String(file.uploadedBy) === user.userId ||
      (await Expense.exists({
        receiptImage: reference,
        createdBy: user.userId,
      })))
  )
    return file;
  if (
    file.references === 0 &&
    String(file.uploadedBy) === user.userId &&
    user.role !== "student"
  ) {
    if (file.scopeId) {
      const subject =
        file.purpose === "material"
          ? await Lecture.findById(file.scopeId).then(
              (l) => l && PackageSubject.findById(l.packageSubjectId),
            )
          : await PackageSubject.findById(file.scopeId);
      ensure(subject, 403, "FILE_ACCESS_DENIED");
      await contentPermission(
        user,
        subject.packageId,
        subject._id,
        "content:view",
      );
    }
    return file;
  }
  throw new ApiError(403, "FILE_ACCESS_DENIED");
}
