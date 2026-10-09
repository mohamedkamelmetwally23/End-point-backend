import mongoose, { Schema, type SchemaDefinition } from "mongoose";
export const roles = [
  "super_admin",
  "content_manager",
  "lecturer",
  "student",
] as const;
export const permissions = [
  "content:view",
  "content:create",
  "content:edit",
  "content:delete_draft",
  "content:publish",
  "content:archive",
] as const;
const ref = (model: string, required = true) => ({
  type: Schema.Types.ObjectId,
  ref: model,
  required,
});
const status = (values: string[], value: string) => ({
  type: String,
  enum: values,
  default: value,
  required: true,
});
const name = { type: String, required: true, trim: true, maxlength: 160 };
function model(
  collection: string,
  fields: SchemaDefinition,
  indexes: Array<[Record<string, 1 | -1>, Record<string, unknown>]> = [],
) {
  const schema = new Schema(fields, {
    timestamps: true,
    collection,
    strict: "throw",
  });
  for (const [keys, options] of indexes) schema.index(keys, options);
  schema.pre("validate", function () {
    if (collection === "users" && this.get("role") === "student") {
      for (const field of ["collegeId", "academicYearId", "phone"])
        if (!this.get(field))
          this.invalidate(field, "Required student placement or phone");
    }
    if (collection === "packages") {
      const price = Number(this.get("price"));
      if (this.get("isFree") ? price !== 0 : price <= 0)
        this.invalidate("price", "Price must match free/paid package");
    }
    if (collection === "materials") {
      const type = this.get("type");
      const value = this.get(type === "text" ? "body" : "url");
      if (typeof value !== "string" || !value.trim())
        this.invalidate(
          type === "text" ? "body" : "url",
          "Material content required",
        );
      if (
        type !== "text" &&
        typeof value === "string" &&
        !value.startsWith("https://") &&
        !/^\/api\/v1\/files\/[a-f\d]{24}\.(pdf|png|jpg|webp)$/.test(value)
      )
        this.invalidate("url", "HTTPS required");
    }
    if (collection === "staff_assignments") {
      const hasSubject = !!this.get("packageSubjectId");
      if ((this.get("scopeType") === "package_subject") !== hasSubject)
        this.invalidate("packageSubjectId", "Assignment scope mismatch");
    }
    if (collection === "lectures") {
      if (this.get("status") === "scheduled" && !this.get("scheduledAt"))
        this.invalidate("scheduledAt", "Scheduled date required");
      if (this.get("status") === "published" && !this.get("publishedAt"))
        this.invalidate("publishedAt", "Publication date required");
    }
  });
  return mongoose.model(collection, schema);
}
export const User = model("users", {
  fullName: name,
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    unique: true,
  },
  passwordHash: { type: String, required: true, select: false },
  role: { type: String, enum: roles, required: true },
  status: status(["active", "disabled"], "active"),
  phone: { type: String, default: "" },
  collegeId: ref("colleges", false),
  academicYearId: ref("academic_years", false),
});
export const College = model("colleges", {
  name,
  // Keep generating an internal value for compatibility with the existing unique index.
  code: {
    type: String,
    default: () => new mongoose.Types.ObjectId().toHexString(),
    unique: true,
    select: false,
  },
  status: status(["active", "archived"], "active"),
});
export const AcademicYear = model(
  "academic_years",
  {
    name,
    collegeId: ref("colleges"),
    order: { type: Number, default: 0 },
    status: status(["active", "archived"], "active"),
  },
  [[{ collegeId: 1, name: 1 }, { unique: true }]],
);
export const Term = model(
  "terms",
  {
    name,
    academicYearId: ref("academic_years"),
    order: { type: Number, default: 0 },
    localOrder: { type: Number, default: 0 },
    status: status(["active", "inactive", "archived"], "inactive"),
  },
  [
    [{ academicYearId: 1, name: 1 }, { unique: true }],
    [
      { academicYearId: 1 },
      { unique: true, partialFilterExpression: { status: "active" } },
    ],
  ],
);
export const Subject = model("subjects", {
  name,
  description: { type: String, default: "" },
  collegeId: ref("colleges"),
  academicYearId: ref("academic_years", false),
  termId: ref("terms", false),
  status: status(["active", "inactive", "archived"], "active"),
});
export const Package = model(
  "packages",
  {
    name,
    description: { type: String, default: "" },
    collegeId: ref("colleges"),
    academicYearId: ref("academic_years"),
    termId: ref("terms"),
    price: {
      type: Number,
      required: true,
      min: 0,
      validate: Number.isSafeInteger,
    },
    currency: { type: String, enum: ["EGP"], default: "EGP" },
    isFree: { type: Boolean, required: true },
    coverUrl: String,
    status: status(["draft", "active", "archived"], "draft"),
  },
  [[{ collegeId: 1, academicYearId: 1, termId: 1, status: 1 }, {}]],
);
export const PackageSubject = model(
  "package_subjects",
  {
    packageId: ref("packages"),
    subjectId: ref("subjects"),
    order: { type: Number, default: 0 },
    status: status(["active", "archived"], "active"),
  },
  [[{ packageId: 1, subjectId: 1 }, { unique: true }]],
);
export const StaffAssignment = model(
  "staff_assignments",
  {
    userId: ref("users"),
    scopeType: {
      type: String,
      enum: ["package", "package_subject"],
      required: true,
    },
    packageId: ref("packages"),
    packageSubjectId: ref("package_subjects", false),
    permissions: [{ type: String, enum: permissions }],
    active: { type: Boolean, default: true },
  },
  [
    [
      { userId: 1, packageId: 1, scopeType: 1, packageSubjectId: 1 },
      { unique: true },
    ],
  ],
);
export const Lecture = model(
  "lectures",
  {
    packageSubjectId: ref("package_subjects"),
    title: name,
    description: { type: String, default: "" },
    order: { type: Number, default: 0 },
    duration: { type: Number, min: 0 },
    youtubeUrl: String,
    summaryUrl: String,
    status: status(["draft", "scheduled", "published", "archived"], "draft"),
    scheduledAt: Date,
    publishedAt: Date,
    createdBy: ref("users"),
    updatedBy: ref("users"),
  },
  [
    [{ packageSubjectId: 1, status: 1, publishedAt: -1 }, {}],
    [{ status: 1, scheduledAt: 1 }, {}],
  ],
);
export const Material = model(
  "materials",
  {
    lectureId: ref("lectures"),
    type: {
      type: String,
      enum: ["youtube", "pdf", "image", "text"],
      required: true,
    },
    title: name,
    url: String,
    body: String,
    order: { type: Number, default: 0 },
  },
  [[{ lectureId: 1, order: 1 }, {}]],
);
export const PackageAccess = model(
  "package_access",
  {
    studentId: ref("users"),
    packageId: ref("packages"),
    source: {
      type: String,
      enum: ["free", "paid_order", "manual"],
      required: true,
    },
    status: status(["active", "revoked"], "active"),
    grantedAt: { type: Date, required: true },
    grantedBy: ref("users", false),
    revokedAt: Date,
    revokedBy: ref("users", false),
  },
  [
    [{ studentId: 1, packageId: 1 }, { unique: true }],
    [{ packageId: 1, status: 1 }, {}],
  ],
);
export const Order = model(
  "orders",
  {
    studentId: ref("users"),
    packageId: ref("packages"),
    priceSnapshot: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    currency: { type: String, enum: ["EGP"], default: "EGP" },
    status: status(["pending", "completed", "cancelled"], "pending"),
    completedAt: Date,
    completedBy: ref("users", false),
  },
  [
    [
      { studentId: 1, packageId: 1 },
      { unique: true, partialFilterExpression: { status: "pending" } },
    ],
    [{ status: 1, completedAt: 1 }, {}],
  ],
);
export const LectureProgress = model(
  "lecture_progress",
  {
    studentId: ref("users"),
    packageId: ref("packages"),
    packageSubjectId: ref("package_subjects"),
    lectureId: ref("lectures"),
    completedAt: { type: Date, required: true },
  },
  [[{ studentId: 1, lectureId: 1 }, { unique: true }]],
);
export const Expense = model(
  "expenses",
  {
    createdBy: ref("users"),
    category: name,
    amount: {
      type: Number,
      required: true,
      min: 1,
      validate: Number.isSafeInteger,
    },
    currency: { type: String, enum: ["EGP"], default: "EGP" },
    date: { type: Date, required: true },
    notes: String,
    receiptUrl: String,
    receiptImage: String,
  },
  [[{ createdBy: 1, date: -1 }, {}]],
);
export const AuditLog = model(
  "audit_logs",
  {
    actor: ref("users", false),
    action: name,
    entityType: name,
    entityId: String,
    metadata: Schema.Types.Mixed,
    timestamp: { type: Date, default: Date.now, immutable: true },
  },
  [[{ timestamp: -1 }, {}]],
);
export const StudentDevice = model("student_devices", {
  studentId: { ...ref("users"), unique: true },
  tokenHash: { type: String, required: true, select: false },
  userAgentHash: String,
  registeredAt: { type: Date, required: true },
});
export const Session = model(
  "sessions",
  {
    userId: ref("users"),
    tokenHash: { type: String, required: true, unique: true, select: false },
    expiresAt: { type: Date, required: true },
  },
  [
    [{ expiresAt: 1 }, { expireAfterSeconds: 0 }],
    [{ userId: 1 }, {}],
  ],
);
export const models = {
  users: User,
  colleges: College,
  academic_years: AcademicYear,
  terms: Term,
  subjects: Subject,
  packages: Package,
  package_subjects: PackageSubject,
  staff_assignments: StaffAssignment,
  lectures: Lecture,
  materials: Material,
  package_access: PackageAccess,
  orders: Order,
  lecture_progress: LectureProgress,
  expenses: Expense,
  audit_logs: AuditLog,
  student_devices: StudentDevice,
  sessions: Session,
};
