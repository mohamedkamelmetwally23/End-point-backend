import { describe, it, expect } from "vitest";
import {
  materialSchema,
  packageSchema,
  youtubeId,
  assignmentSchema,
  academicSchemas,
  receiptImageSchema,
  lectureSchema,
  summaryPdfSchema,
} from "../src/modules/domain/validation.js";
import { confirmedTestDatabase } from "../scripts/database-tools.js";
const oid = "507f1f77bcf86cd799439011";
describe("Domain validation", () => {
  it("accepts an uploaded PDF summary and rejects disguised files", () => {
    const pdf =
      "data:application/pdf;base64," +
      Buffer.from("%PDF-1.4\n%%EOF").toString("base64");
    expect(summaryPdfSchema.safeParse(pdf).success).toBe(true);
    expect(
      lectureSchema.safeParse({
        packageSubjectId: oid,
        title: "Large PDF summary",
        summaryUrl:
          "/api/v1/summary-pdfs/550e8400-e29b-41d4-a716-446655440000.pdf",
      }).success,
    ).toBe(true);
    expect(
      lectureSchema.safeParse({
        packageSubjectId: oid,
        title: "Lecture",
        summaryUrl: pdf,
      }).success,
    ).toBe(false);
    expect(
      summaryPdfSchema.safeParse("data:application/pdf;base64,aGVsbG8=")
        .success,
    ).toBe(false);
    expect(
      summaryPdfSchema.safeParse(
        "data:application/pdf;base64," +
          Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      ).success,
    ).toBe(false);
  });
  it("accepts YouTube lecture links and rejects other video hosts", () => {
    const lecture = { packageSubjectId: oid, title: "Video" };
    expect(
      lectureSchema.safeParse({
        ...lecture,
        youtubeUrl: "https://youtu.be/dQw4w9WgXcQ",
      }).success,
    ).toBe(true);
    expect(
      lectureSchema.safeParse({
        ...lecture,
        youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      }).success,
    ).toBe(true);
    expect(
      lectureSchema.safeParse({
        ...lecture,
        youtubeUrl: "https://evil.example/watch?v=dQw4w9WgXcQ",
      }).success,
    ).toBe(false);
    expect(
      lectureSchema.safeParse({ ...lecture, youtubeUrl: null }).success,
    ).toBe(true);
  });
  it("validates receipt Base64 format, image signature and size", () => {
    const png =
      "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jD1sAAAAASUVORK5CYII=";
    expect(receiptImageSchema.safeParse(png).success).toBe(true);
    expect(
      receiptImageSchema.safeParse("data:image/png;base64,aGVsbG8=").success,
    ).toBe(false);
    expect(
      receiptImageSchema.safeParse("data:image/svg+xml;base64,PHN2Zz4=")
        .success,
    ).toBe(false);
    expect(
      receiptImageSchema.safeParse(
        "data:image/png;base64," +
          Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64"),
      ).success,
    ).toBe(false);
  });
  it("accepts colleges and subjects without a code", () => {
    expect(academicSchemas.colleges.parse({ name: "College" })).toEqual({
      name: "College",
      status: "active",
    });
    expect(
      academicSchemas.subjects.safeParse({
        name: "Subject",
        collegeId: oid,
        academicYearId: oid,
        termId: oid,
      }).success,
    ).toBe(true);
    expect(
      academicSchemas.subjects.safeParse({ name: "Subject", collegeId: oid })
        .success,
    ).toBe(false);
    expect(
      academicSchemas.colleges.safeParse({ name: "College", yearCount: 4 })
        .success,
    ).toBe(true);
    expect(
      academicSchemas.colleges.safeParse({ name: "College", yearCount: 4.5 })
        .success,
    ).toBe(false);
    expect(
      academicSchemas.colleges.parse({ name: "College", code: "legacy" }),
    ).not.toHaveProperty("code");
  });
  it("refuses production and ambiguous reset targets", () => {
    for (const db of ["endpoint", "prod", "production", "customer_test"])
      expect(() => confirmedTestDatabase(db, "development")).toThrow();
    expect(() => confirmedTestDatabase("test", "production")).toThrow();
    expect(() => confirmedTestDatabase("test", "development")).not.toThrow();
  });
  it("validates material bodies and safe video references", () => {
    expect(
      materialSchema.safeParse({ lectureId: oid, type: "text", title: "Text" })
        .success,
    ).toBe(false);
    expect(
      materialSchema.safeParse({
        lectureId: oid,
        type: "youtube",
        title: "Video",
        url: "https://evil.example/watch?v=dQw4w9WgXcQ",
      }).success,
    ).toBe(false);
    expect(youtubeId("https://youtu.be/dQw4w9WgXcQ")).toBe("dQw4w9WgXcQ");
    expect(
      materialSchema.safeParse({
        lectureId: oid,
        type: "pdf",
        title: "Notes",
        url: "https://example.com/notes.pdf",
      }).success,
    ).toBe(true);
  });
  it("validates package price and scope", () => {
    const pkg = {
      name: "Term",
      collegeId: oid,
      academicYearId: oid,
      termId: oid,
      isFree: true,
      price: 100,
    };
    expect(packageSchema.safeParse(pkg).success).toBe(false);
    expect(
      assignmentSchema.safeParse({
        userId: oid,
        packageId: oid,
        scopeType: "package_subject",
      }).success,
    ).toBe(false);
  });
});
