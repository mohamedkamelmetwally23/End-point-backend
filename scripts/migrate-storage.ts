import "dotenv/config";
import mongoose from "mongoose";
import path from "node:path";
import { readFile, readdir, realpath } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { connect, transaction } from "../src/shared/database.js";
import {
  Lecture,
  Material,
  Expense,
  Package,
  User,
} from "../src/modules/domain/models.js";
import {
  StoredFile,
  validSignature,
  fileReference,
} from "../src/storage/storage.service.js";
import {
  blobProvider,
  type Visibility,
} from "../src/storage/vercel-blob.provider.js";
import { ensure } from "../src/shared/errors.js";

export function legacyPath(value: string, root: string) {
  let relative: string;
  if (value.startsWith("file://")) relative = fileURLToPath(value);
  else if (/^[a-z]:[\\/]/i.test(value)) relative = value;
  else {
    const pathname = /^https?:\/\//.test(value)
      ? new URL(value).pathname
      : value;
    relative = pathname
      .replace(/^\/api\/v1\/summary-pdfs\//, "storage/summary-pdfs/")
      .replace(/^\/?summary-pdfs\//, "storage/summary-pdfs/")
      .replace(/^\/+/, "");
  }
  const resolved = path.resolve(root, relative);
  const inside = path.relative(path.resolve(root), resolved);
  ensure(
    inside !== ".." &&
      !inside.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(inside),
    400,
    "LEGACY_PATH_OUTSIDE_ROOT",
  );
  return resolved;
}
export function isLegacy(value: string) {
  return (
    value.startsWith("data:") ||
    value.startsWith("blob:") ||
    value.startsWith("file:") ||
    /^[a-z]:[\\/]/i.test(value) ||
    /localhost|127\.0\.0\.1|\/uploads\/|\/summary-pdfs\/|^\.?\/?(?:public|storage|uploads|summary-pdfs)\//.test(
      value,
    )
  );
}
export async function migrateStorage(apply: boolean, root: string) {
  if (apply) await StoredFile.init();
  const admin = await User.findOne({ role: "super_admin" }).select("_id");
  const report: object[] = [];
  const seen = new Set<string>();
  for (const [collection, field, purpose] of [
    [Lecture, "summaryUrl", "summary"],
    [Material, "url", "material"],
    [Expense, "receiptImage", "receipt"],
    [Expense, "receiptUrl", "receipt"],
    [Package, "coverUrl", "cover"],
  ] as const) {
    for (const row of await collection.find({ [field]: { $type: "string" } })) {
      const original = String(row.get(field));
      if (!isLegacy(original)) continue;
      const entry = {
        collection: collection.collection.name,
        id: String(row._id),
        field,
      };
      let bytes: Buffer, originalName: string, mimeType: string;
      try {
        if (original.startsWith("data:")) {
          const match =
            /^data:(application\/pdf|image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
              original,
            );
          ensure(match, 400, "INVALID_LEGACY_DATA");
          bytes = Buffer.from(match[2]!, "base64");
          mimeType = match[1]!;
          originalName = `legacy.${mimeType === "application/pdf" ? "pdf" : mimeType.split("/")[1]}`;
        } else {
          ensure(!original.startsWith("blob:"), 404, "FILE_REUPLOAD_REQUIRED");
          const filename = legacyPath(original, root);
          seen.add(filename);
          const actual = await realpath(filename),
            actualRoot = await realpath(root);
          const relative = path.relative(actualRoot, actual);
          ensure(
            relative !== ".." &&
              !relative.startsWith(`..${path.sep}`) &&
              !path.isAbsolute(relative),
            400,
            "LEGACY_PATH_OUTSIDE_ROOT",
          );
          bytes = await readFile(actual);
          originalName = path.basename(filename);
          mimeType =
            (
              {
                ".pdf": "application/pdf",
                ".png": "image/png",
                ".jpg": "image/jpeg",
                ".jpeg": "image/jpeg",
                ".webp": "image/webp",
              } as Record<string, string>
            )[path.extname(filename).toLowerCase()] || "";
        }
        ensure(validSignature(bytes, mimeType), 400, "INVALID_FILE_TYPE");
        ensure(
          bytes.length <=
            (mimeType === "application/pdf" ? 20 : 2) * 1024 * 1024,
          400,
          "FILE_TOO_LARGE",
        );
        if (!apply) {
          report.push({
            ...entry,
            result: "ready_to_migrate",
            size: bytes.length,
          });
          continue;
        }
        const uploadedBy = row.get("createdBy") || admin?._id;
        ensure(uploadedBy, 400, "MIGRATION_UPLOADER_REQUIRED");
        const visibility: Visibility =
          purpose === "cover" ? "public" : "private";
        const pathname = `endpoint/migrated/${randomUUID()}${path.extname(originalName)}`;
        const blob = await blobProvider.put(
          pathname,
          bytes,
          visibility,
          mimeType,
        );
        try {
          await transaction(async (session) => {
            const current = await collection.findById(row._id).session(session);
            ensure(
              current?.get(field) === original,
              409,
              "MIGRATION_RECORD_CHANGED",
            );
            const file = (
              await StoredFile.create(
                [
                  {
                    pathname,
                    blobUrl: blob.url,
                    originalName,
                    mimeType,
                    size: bytes.length,
                    uploadedBy,
                    purpose,
                    visibility,
                    status: "ready",
                    references: 1,
                    scopeId:
                      purpose === "summary"
                        ? String(row.get("packageSubjectId"))
                        : purpose === "material"
                          ? String(row.get("lectureId"))
                          : undefined,
                  },
                ],
                { session },
              )
            )[0]!;
            await collection.updateOne(
              { _id: row._id, [field]: original },
              {
                $set: {
                  [field]: fileReference(
                    file as Parameters<typeof fileReference>[0],
                  ),
                },
              },
              { session },
            );
          });
        } catch (error) {
          await blobProvider
            .delete(pathname, visibility)
            .catch(() => undefined);
          throw error;
        }
        report.push({ ...entry, result: "migrated" });
      } catch (error) {
        report.push({
          ...entry,
          result: "manual_reupload_or_retry",
          reason:
            error instanceof Error && "code" in error
              ? String(error.code)
              : "FILE_REUPLOAD_REQUIRED",
        });
      }
    }
  }
  async function files(directory: string): Promise<string[]> {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    return (
      await Promise.all(
        entries.map((entry) =>
          entry.isDirectory()
            ? files(path.join(directory, entry.name))
            : [path.join(directory, entry.name)],
        ),
      )
    ).flat();
  }
  for (const filename of await files(path.resolve(root, "storage")))
    if (!seen.has(filename))
      report.push({
        localFile: path.relative(root, filename),
        result: "unreferenced_local_file_preserved",
      });
  return report;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    await connect();
    const index = process.argv.indexOf("--legacy-root");
    const root =
      index >= 0 ? path.resolve(process.argv[index + 1]!) : process.cwd();
    console.log(
      JSON.stringify(
        {
          database: mongoose.connection.name,
          apply: process.argv.includes("--apply"),
          records: await migrateStorage(process.argv.includes("--apply"), root),
        },
        null,
        2,
      ),
    );
  } finally {
    await mongoose.disconnect();
  }
}
