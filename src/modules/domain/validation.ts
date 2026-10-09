import { z } from "zod";
import { permissions, roles } from "./models.js";
export const id = z.string().regex(/^[a-f\d]{24}$/i);
const name = z.string().trim().min(1).max(160);
const description = z.string().max(20000).default("");
const https = z
  .string()
  .url()
  .refine(
    (v) => URL.canParse(v) && new URL(v).protocol === "https:",
    "HTTPS required",
  );
const storedReference = z
  .string()
  .regex(/^\/api\/v1\/files\/[a-f\d]{24}\.(?:pdf|png|jpg|webp)$/);
export const academicYearsCountSchema = z.object({
  collegeId: id,
  yearCount: z.number().int().min(1).max(12),
  status: z.enum(["active", "archived"]).default("active"),
});
export const academicSchemas = {
  colleges: z.object({
    name,
    yearCount: z.number().int().min(1).max(12).optional(),
    status: z.enum(["active", "archived"]).default("active"),
  }),
  academic_years: z.object({
    name,
    collegeId: id,
    order: z.number().int().min(0).default(0),
    status: z.enum(["active", "archived"]).default("active"),
  }),
  terms: z.object({
    name,
    academicYearId: id,
    order: z.number().int().min(0).optional(),
    localOrder: z.number().int().min(1).max(2).optional(),
    status: z.enum(["active", "inactive", "archived"]).default("inactive"),
  }),
  subjects: z.object({
    name,
    description,
    collegeId: id,
    academicYearId: id,
    termId: id,
    status: z.enum(["active", "inactive", "archived"]).default("active"),
  }),
};
export const packageSchema = z
  .object({
    subjectIds: z
      .array(id)
      .min(1)
      .refine((ids) => new Set(ids).size === ids.length)
      .optional(),
    name,
    description,
    collegeId: id,
    academicYearId: id,
    termId: id,
    price: z.number().int().min(0).max(100000000),
    isFree: z.boolean(),
    coverUrl: https.nullable().optional(),
    status: z.enum(["draft", "active", "archived"]).default("draft"),
  })
  .refine(
    (v) => (v.isFree ? v.price === 0 : v.price > 0),
    "Invalid free/paid price",
  );
export const packageSubjectSchema = z.object({
  subjectId: id,
  order: z.number().int().min(0).default(0),
  status: z.enum(["active", "archived"]).default("active"),
});
export const summaryPdfSchema = z
  .string()
  .max(2_796_244)
  .refine((value) => {
    const match = /^data:application\/pdf;base64,([A-Za-z0-9+/]+={0,2})$/.exec(
      value,
    );
    if (!match) return false;
    const bytes = Buffer.from(match[1]!, "base64");
    return (
      bytes.length <= 2 * 1024 * 1024 &&
      bytes.toString("base64") === match[1] &&
      bytes.toString("ascii", 0, 5) === "%PDF-"
    );
  }, "Valid PDF required");
export const lectureSchema = z
  .object({
    packageSubjectId: id,
    title: name,
    description,
    order: z.number().int().min(0).default(0),
    duration: z.number().min(0).optional(),
    summaryUrl: z
      .union([
        https,
        storedReference,
        z.string().regex(/^\/api\/v1\/summary-pdfs\/[a-f0-9-]{36}\.pdf$/),
      ])
      .nullable()
      .optional(),
    youtubeUrl: https
      .refine((value) => !!youtubeId(value), "Valid YouTube video required")
      .nullable()
      .optional(),
    status: z
      .enum(["draft", "scheduled", "published", "archived"])
      .default("draft"),
    scheduledAt: z.iso.datetime().optional(),
  })
  .refine(
    (v) => v.status !== "scheduled" || !!v.scheduledAt,
    "Scheduled date required",
  );
export function youtubeId(value: string): string | null {
  try {
    const u = new URL(value),
      host = u.hostname.replace(/^www\./, "");
    const video =
      host === "youtu.be"
        ? u.pathname.slice(1)
        : ["youtube.com", "m.youtube.com"].includes(host)
          ? u.searchParams.get("v") ||
            u.pathname.match(/^\/(?:embed|shorts)\/([^/]+)$/)?.[1]
          : null;
    return video && /^[\w-]{11}$/.test(video) ? video : null;
  } catch {
    return null;
  }
}
export const materialSchema = z
  .object({
    lectureId: id,
    type: z.enum(["youtube", "pdf", "image", "text"]),
    title: name,
    url: z.union([https, storedReference]).optional(),
    body: z.string().max(100000).optional(),
    order: z.number().int().min(0).default(0),
  })
  .superRefine((v, ctx) => {
    if (v.type === "text" && !v.body?.trim())
      ctx.addIssue({ code: "custom", message: "Text body required" });
    if (v.type !== "text" && !v.url)
      ctx.addIssue({ code: "custom", message: "URL required" });
    if (v.type === "youtube" && v.url && !youtubeId(v.url))
      ctx.addIssue({ code: "custom", message: "Valid YouTube video required" });
    if (
      v.type === "pdf" &&
      v.url &&
      !/\.pdf$/i.test(new URL(v.url, "https://endpoint.invalid").pathname)
    )
      ctx.addIssue({ code: "custom", message: "PDF reference required" });
    if (
      v.type === "image" &&
      v.url &&
      !/\.(png|jpe?g|webp|gif|avif)$/i.test(
        new URL(v.url, "https://endpoint.invalid").pathname,
      )
    )
      ctx.addIssue({ code: "custom", message: "Image reference required" });
  });
export const assignmentSchema = z
  .object({
    userId: id,
    scopeType: z.enum(["package", "package_subject"]),
    packageId: id,
    packageSubjectId: id.optional(),
    permissions: z.array(z.enum(permissions)).default(["content:view"]),
    active: z.boolean().default(true),
  })
  .refine(
    (v) =>
      v.scopeType === "package_subject"
        ? !!v.packageSubjectId
        : !v.packageSubjectId,
    "Scope mismatch",
  );
export const staffSchema = z.object({
  fullName: name,
  email: z.email().toLowerCase(),
  password: z.string().min(12).max(128),
  role: z.enum(roles).refine((v) => v !== "student"),
  phone: z.string().max(30).default(""),
});
export const receiptImageSchema = z
  .string()
  .max(2_796_244)
  .refine((value) => {
    const match =
      /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
    if (!match) return false;
    const bytes = Buffer.from(match[2]!, "base64");
    if (
      !bytes.length ||
      bytes.length > 2 * 1024 * 1024 ||
      bytes.toString("base64") !== match[2]
    )
      return false;
    if (match[1] === "png")
      return bytes
        .subarray(0, 8)
        .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    if (match[1] === "jpeg")
      return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    return (
      bytes.toString("ascii", 0, 4) === "RIFF" &&
      bytes.toString("ascii", 8, 12) === "WEBP"
    );
  }, "Invalid receipt image");
export const expenseSchema = z.object({
  category: name,
  amount: z.number().int().positive().max(100000000),
  currency: z.literal("EGP").default("EGP"),
  date: z.iso.datetime(),
  notes: z.string().max(2000).default(""),
  receiptUrl: z.union([https, storedReference]).nullable().optional(),
  receiptImage: z.union([receiptImageSchema, storedReference]).nullable().optional(),
});
