import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import request from "supertest";
const blobs = vi.hoisted(
  () => new Map<string, { bytes: Buffer; mime: string; visibility: string }>(),
);
vi.mock("../src/storage/vercel-blob.provider.js", () => ({
  blobProvider: {
    put: vi.fn(
      async (
        pathname: string,
        bytes: Buffer,
        visibility: string,
        mime: string,
      ) => {
        blobs.set(pathname, { bytes, mime, visibility });
        return {
          url: `https://test.${visibility}.blob.vercel-storage.com/${pathname}`,
        };
      },
    ),
    head: vi.fn(async (pathname: string) => {
      const blob = blobs.get(pathname)!;
      return {
        pathname,
        size: blob.bytes.length,
        contentType: blob.mime,
        url: `https://test.${blob.visibility}.blob.vercel-storage.com/${pathname}`,
      };
    }),
    get: vi.fn(async (pathname: string) => ({
      statusCode: 200,
      stream: new ReadableStream({
        start(c) {
          c.enqueue(blobs.get(pathname)!.bytes);
          c.close();
        },
      }),
    })),
    delete: vi.fn(async (pathname: string) => {
      blobs.delete(pathname);
    }),
    download: vi.fn(
      async (pathname: string) =>
        `https://test.private.blob.vercel-storage.com/${pathname}?expires=60`,
    ),
    authorizeUpload: vi.fn(async () => ({
      type: "blob.generate-presigned-url",
      presignedUrlPayload: { signature: "test" },
    })),
  },
}));
import { env } from "../src/config/env.js";
import { app } from "../src/app.js";
import {
  models,
  User,
  Subject,
  Package,
  PackageSubject,
  Lecture,
  Material,
  PackageAccess,
  StaffAssignment,
} from "../src/modules/domain/models.js";
import {
  StoredFile,
  prepareUpload,
  completeUpload,
  authorizeDownload,
  cleanupFile,
  fileReference,
  bindFile,
  uploadFile,
  createDownloadAccess,
} from "../src/storage/storage.service.js";
import { blobProvider } from "../src/storage/vercel-blob.provider.js";
import {
  saveMaterial,
  saveLecture,
  deleteDraft,
} from "../src/modules/content/service.js";
import { saveExpense, deleteExpense } from "../src/modules/finance/service.js";
import { transaction } from "../src/shared/database.js";
import { confirmedTestDatabase } from "../scripts/database-tools.js";
import {
  legacyPath,
  isLegacy,
  migrateStorage,
} from "../scripts/migrate-storage.js";
import type { Principal } from "../src/modules/staff-assignments/service.js";

describe("Blob storage with real MongoDB and mocked external Blob transport", () => {
  const oid = () => String(new mongoose.Types.ObjectId());
  const admin: Principal = { userId: oid(), role: "super_admin" };
  const student: Principal = { userId: oid(), role: "student" };
  const lecturer: Principal = { userId: oid(), role: "lecturer" };
  const manager: Principal = { userId: oid(), role: "content_manager" };
  let ps: string, lectureId: string, packageId: string;
  const pdf = Buffer.from("%PDF-1.7\nexample content");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=",
    "base64",
  );
  beforeAll(async () => {
    await mongoose.connect(env.MONGODB_URI, {
      dbName: `ep_rebuild_test_storage_${Date.now()}`,
    });
    for (const model of [...Object.values(models), StoredFile]) {
      await model.createCollection();
      await model.syncIndexes();
    }
    await User.create({
      _id: admin.userId,
      fullName: "Storage Admin",
      email: "storage@test.local",
      passwordHash: "unused",
      role: "super_admin",
    });
    const subject = await Subject.create({ name: "Storage", collegeId: oid() });
    const pkg = await Package.create({
      name: "Paid",
      collegeId: oid(),
      academicYearId: oid(),
      termId: oid(),
      price: 100,
      isFree: false,
      status: "active",
    });
    packageId = String(pkg._id);
    ps = String(
      (await PackageSubject.create({ packageId, subjectId: subject._id }))._id,
    );
    lectureId = String(
      (
        await Lecture.create({
          packageSubjectId: ps,
          title: "Files",
          status: "published",
          publishedAt: new Date(),
          createdBy: admin.userId,
          updatedBy: admin.userId,
        })
      )._id,
    );
    for (const user of [lecturer, manager])
      await StaffAssignment.create({
        userId: user.userId,
        scopeType: "package_subject",
        packageId,
        packageSubjectId: ps,
        permissions: [
          "content:view",
          "content:create",
          "content:edit",
          "content:publish",
        ],
        active: true,
      });
  }, 120000);
  afterAll(async () => {
    confirmedTestDatabase(mongoose.connection.name, "test");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }, 30000);
  async function uploaded(
    purpose: string,
    bytes = pdf,
    mimeType = "application/pdf",
    user = admin,
  ) {
    const prepared = await prepareUpload(user, {
      purpose,
      originalName: mimeType === "application/pdf" ? "test.pdf" : "test.png",
      size: bytes.length,
      mimeType,
      ...(["summary", "material"].includes(purpose)
        ? { scopeId: purpose === "summary" ? ps : lectureId }
        : {}),
    });
    blobs.set(prepared.pathname!, {
      bytes,
      mime: mimeType,
      visibility: prepared.access!,
    });
    return completeUpload(user, prepared.id);
  }
  it("persists clean PDF and image metadata, never bytes or disk paths", async () => {
    for (const [purpose, bytes, mime] of [
      ["summary", pdf, "application/pdf"],
      ["material", png, "image/png"],
      ["cover", png, "image/png"],
    ] as const) {
      const result = await uploaded(purpose, bytes, mime);
      const file = (await StoredFile.findById(result.id).lean())!;
      expect(file.storageProvider).toBe("vercel-blob");
      expect(file.size).toBe(bytes.length);
      expect(file.originalName).toBe(
        mime === "application/pdf" ? "test.pdf" : "test.png",
      );
      expect(file.visibility).toBe(purpose === "cover" ? "public" : "private");
      expect(JSON.stringify(file)).not.toMatch(
        /data:|localhost|C:\\\\|\/uploads\//,
      );
      expect(result.url).toMatch(
        purpose === "cover"
          ? /^https:\/\/test.public.blob/
          : /^\/api\/v1\/files\//,
      );
      expect(result).not.toHaveProperty("blobUrl");
    }
  });
  it("stores server-generated summaries without local filesystem dependency", async () => {
    const saved = await uploadFile(admin, pdf, {
      purpose: "summary",
      scopeId: ps,
      mimeType: "application/pdf",
      originalName: "generated.pdf",
    });
    expect(saved.url).toMatch(/^\/api\/v1\/files\//);
    expect((await StoredFile.findById(saved.id))!.originalName).toBe(
      "generated.pdf",
    );
    expect(await createDownloadAccess(admin, saved.id)).toContain("expires=60");
  });
  it("persists private receipt images, enforces ownership, and cleans replacements/deletion", async () => {
    const first = await uploaded("receipt", png, "image/png", manager);
    const firstKey = (await StoredFile.findById(first.id))!.pathname!;
    const fields = {
      category: "Storage receipt",
      amount: 100,
      date: new Date().toISOString(),
      receiptImage: first.url,
    };
    const expense = await saveExpense(manager, fields);
    expect(expense.receiptImage).toMatch(/^\/api\/v1\/files\//);
    await expect(authorizeDownload(manager, first.id)).resolves.toHaveProperty(
      "pathname",
    );
    await expect(authorizeDownload(lecturer, first.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
    await expect(authorizeDownload(student, first.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
    await saveExpense(
      manager,
      { category: "Retained", amount: 100, date: fields.date },
      String(expense._id),
    );
    expect(blobs.has(firstKey)).toBe(true);
    const next = await uploaded("receipt", png, "image/png", manager);
    const nextKey = (await StoredFile.findById(next.id))!.pathname!;
    await saveExpense(
      manager,
      { ...fields, receiptImage: next.url },
      String(expense._id),
    );
    expect(blobs.has(firstKey)).toBe(false);
    await deleteExpense(manager, String(expense._id));
    expect(blobs.has(nextKey)).toBe(false);
  });
  it("enforces size, MIME, ownership and package scope before upload", async () => {
    const data = {
      purpose: "summary",
      scopeId: ps,
      originalName: "x.pdf",
      mimeType: "application/pdf",
      size: 20 * 1024 * 1024,
    };
    await expect(prepareUpload(admin, data)).resolves.toHaveProperty("id");
    await expect(
      prepareUpload(admin, { ...data, size: data.size + 1 }),
    ).rejects.toThrow("FILE_TOO_LARGE");
    await expect(prepareUpload(student, data)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
    await expect(
      prepareUpload({ ...lecturer, userId: oid() }, data),
    ).rejects.toThrow("CONTENT_PERMISSION_DENIED");
    await expect(prepareUpload(lecturer, data)).resolves.toHaveProperty("id");
    await expect(prepareUpload(manager, data)).resolves.toHaveProperty("id");
    await expect(
      prepareUpload(admin, { ...data, mimeType: "image/png", size: 100 }),
    ).rejects.toThrow("INVALID_FILE_TYPE");
    const pending = await prepareUpload(admin, data);
    await expect(completeUpload(lecturer, pending.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
  });
  it("rejects forged Blob metadata/signatures and reports transport failure", async () => {
    const pending = await prepareUpload(admin, {
      purpose: "summary",
      scopeId: ps,
      originalName: "bad.pdf",
      mimeType: "application/pdf",
      size: 5,
    });
    blobs.set(pending.pathname!, {
      bytes: Buffer.from("wrong"),
      mime: "application/pdf",
      visibility: "private",
    });
    await expect(completeUpload(admin, pending.id)).rejects.toThrow(
      "INVALID_FILE_TYPE",
    );
    expect(blobs.has(pending.pathname!)).toBe(false);
    vi.mocked(blobProvider.head).mockRejectedValueOnce(
      new Error("private secret transport"),
    );
    const other = await prepareUpload(admin, {
      purpose: "summary",
      scopeId: ps,
      originalName: "x.pdf",
      mimeType: "application/pdf",
      size: 5,
    });
    await expect(completeUpload(admin, other.id)).rejects.toThrow(
      "FILE_UPLOAD_FAILED",
    );
  });
  it("protects summary/material downloads through active Package Access and scoped staff permissions", async () => {
    const file = await uploaded("material");
    await saveMaterial(admin, {
      lectureId,
      title: "Protected",
      type: "pdf",
      url: file.url,
    });
    await expect(authorizeDownload(student, file.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
    const access = await PackageAccess.create({
      studentId: student.userId,
      packageId,
      source: "manual",
      status: "active",
      grantedBy: admin.userId,
      grantedAt: new Date(),
    });
    await expect(authorizeDownload(student, file.id)).resolves.toHaveProperty(
      "pathname",
    );
    await expect(authorizeDownload(admin, file.id)).resolves.toHaveProperty(
      "pathname",
    );
    await expect(authorizeDownload(lecturer, file.id)).resolves.toHaveProperty(
      "pathname",
    );
    await expect(authorizeDownload(manager, file.id)).resolves.toHaveProperty(
      "pathname",
    );
    await expect(
      authorizeDownload({ ...manager, userId: oid() }, file.id),
    ).rejects.toThrow("FILE_ACCESS_DENIED");
    await access.set({ status: "revoked" }).save();
    await expect(authorizeDownload(student, file.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
    await request(app).get(file.url).expect(401);
    const summary = await uploaded("summary");
    await saveLecture(
      admin,
      {
        packageSubjectId: ps,
        title: "Files",
        status: "published",
        summaryUrl: summary.url,
      },
      lectureId,
    );
    await expect(
      authorizeDownload(lecturer, summary.id),
    ).resolves.toHaveProperty("pathname");
    await expect(authorizeDownload(student, summary.id)).rejects.toThrow(
      "FILE_ACCESS_DENIED",
    );
  });
  it("keeps the old Blob on failed replacement and deletes it only after successful DB update", async () => {
    const old = await uploaded("material"),
      replacement = await uploaded("material");
    const material = await saveMaterial(admin, {
      lectureId,
      title: "Replace",
      type: "pdf",
      url: old.url,
    });
    const oldKey = (await StoredFile.findById(old.id))!.pathname!;
    await expect(
      saveMaterial(
        admin,
        {
          lectureId,
          title: "Replace",
          type: "pdf",
          url: `/api/v1/files/${oid()}.pdf`,
        },
        String(material._id),
      ),
    ).rejects.toThrow("FILE_NOT_FOUND");
    expect(blobs.has(oldKey)).toBe(true);
    await saveMaterial(
      admin,
      { lectureId, title: "Replace", type: "pdf", url: replacement.url },
      String(material._id),
    );
    expect(blobs.has(oldKey)).toBe(false);
    expect((await Material.findById(material._id))!.url).toBe(replacement.url);
  });
  it("does not delete shared files, cleans deleted drafts, retries failed deletion", async () => {
    const draft = await Lecture.create({
      packageSubjectId: ps,
      title: "Draft",
      createdBy: admin.userId,
      updatedBy: admin.userId,
    });
    const draftId = String(draft._id);
    const prepared = await prepareUpload(admin, {
      purpose: "material",
      scopeId: draftId,
      originalName: "draft.pdf",
      mimeType: "application/pdf",
      size: pdf.length,
    });
    blobs.set(prepared.pathname!, {
      bytes: pdf,
      mime: "application/pdf",
      visibility: "private",
    });
    const file = await completeUpload(admin, prepared.id);
    const first = await saveMaterial(admin, {
      lectureId: draftId,
      title: "First",
      type: "pdf",
      url: file.url,
    });
    const second = await saveMaterial(admin, {
      lectureId: draftId,
      title: "Second",
      type: "pdf",
      url: file.url,
    });
    await deleteDraft(admin, "materials", String(first._id));
    expect(blobs.has(prepared.pathname!)).toBe(true);
    vi.mocked(blobProvider.delete).mockRejectedValueOnce(new Error("offline"));
    await deleteDraft(admin, "materials", String(second._id));
    expect((await StoredFile.findById(file.id))!.status).toBe("deleting");
    expect((await StoredFile.findById(file.id))!.references).toBe(0);
  });
  it("rolls reference changes back with the business transaction", async () => {
    const file = await uploaded("material");
    await expect(
      transaction(async (session) => {
        await bindFile(admin, file.url, null, "material", lectureId, session);
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await StoredFile.findById(file.id))!.references).toBe(0);
    await cleanupFile(file.url);
    expect(await StoredFile.findById(file.id)).toBeNull();
  });
  it("preserves omitted summary fields and never deletes a file still referenced by content", async () => {
    const file = await uploaded("summary");
    await saveLecture(
      admin,
      {
        packageSubjectId: ps,
        title: "Files",
        status: "published",
        summaryUrl: file.url,
      },
      lectureId,
    );
    await saveLecture(
      admin,
      { packageSubjectId: ps, title: "Renamed", status: "published" },
      lectureId,
    );
    expect((await Lecture.findById(lectureId))!.summaryUrl).toBe(file.url);
    expect((await StoredFile.findById(file.id))!.references).toBe(1);
    await StoredFile.updateOne({ _id: file.id }, { $set: { references: 0 } });
    await cleanupFile(file.url);
    expect((await StoredFile.findById(file.id))!.status).toBe("ready");
    expect((await StoredFile.findById(file.id))!.references).toBe(1);
  });
  it("migrates legacy inline data preserving IDs and reports missing files without deleting records", async () => {
    const legacy = await Lecture.create({
      packageSubjectId: ps,
      title: "Legacy",
      createdBy: admin.userId,
      updatedBy: admin.userId,
      summaryUrl: `data:application/pdf;base64,${pdf.toString("base64")}`,
    });
    const missing = await Lecture.create({
      packageSubjectId: ps,
      title: "Missing",
      createdBy: admin.userId,
      updatedBy: admin.userId,
      summaryUrl:
        "/api/v1/summary-pdfs/00000000-0000-0000-0000-000000000000.pdf",
    });
    const report = await migrateStorage(true, process.cwd());
    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: String(legacy._id), result: "migrated" }),
        expect.objectContaining({
          id: String(missing._id),
          result: "manual_reupload_or_retry",
        }),
      ]),
    );
    expect((await Lecture.findById(legacy._id))!.summaryUrl).toMatch(
      /^\/api\/v1\/files\//,
    );
    expect((await Lecture.findById(missing._id))!.summaryUrl).toContain(
      "summary-pdfs",
    );
    expect(isLegacy("blob:http://localhost/file")).toBe(true);
    expect(() =>
      legacyPath("/uploads/../../../../escape.pdf", process.cwd()),
    ).toThrow("LEGACY_PATH_OUTSIDE_ROOT");
    const f = (await StoredFile.findOne({
      purpose: "summary",
      references: 1,
      scopeId: ps,
    }))!;
    expect(fileReference(f as Parameters<typeof fileReference>[0])).toMatch(
      /^\/api\/v1\/files\//,
    );
  });
});
