// Local-only, repeatable measurements. Never reads the configured database URI.
import mongoose from "mongoose";
import assert from "node:assert/strict";
import bcrypt from "bcryptjs";
import request from "supertest";
import { performance } from "node:perf_hooks";
import { mkdir, writeFile } from "node:fs/promises";

process.env.NODE_ENV = "test";
process.env.MONGODB_URI = "mongodb://127.0.0.1:27028/ep_review_test?replicaSet=endpointReview";
process.env.COOKIE_SECRET = "local-performance-review-cookie-secret-only";
const { app } = await import("../src/app.js");
const { models, User, College, AcademicYear, Term, Subject, Package, PackageSubject,
  Lecture, Material, PackageAccess, LectureProgress, StaffAssignment, Order, Expense } =
  await import("../src/modules/domain/models.js");
const { publishScheduled } = await import("../src/modules/content/service.js");
const database = `ep_rebuild_test_performance_${Date.now()}`;
const phase = process.argv[2] || "baseline";
if (!/^[a-z-]+$/.test(phase)) throw new Error("Invalid measurement label");
await mongoose.connect(process.env.MONGODB_URI, { dbName: database, monitorCommands: true });
const operations: string[] = [];
let collecting = false;
const commands: string[] = [];
mongoose.connection.getClient().on("commandStarted", event => {
  if (collecting) commands.push(event.commandName);
});
mongoose.set("debug", (collection: string, method: string) => {
  if (collecting) operations.push(`${collection}.${method}`);
});
try {
  for (const model of Object.values(models)) await model.init();
  const password = "Performance-test-password!";
  const passwordHash = await bcrypt.hash(password, 12);
  const admin = await User.create({ fullName: "Review Admin", email: "admin@review.test", passwordHash, role: "super_admin" });
  const lecturer = await User.create({ fullName: "Review Lecturer", email: "lecturer@review.test", passwordHash, role: "lecturer" });
  const college = await College.create({ name: "Review College" });
  const year = await AcademicYear.create({ name: "1", collegeId: college._id });
  const term = await Term.create({ name: "Term 1", academicYearId: year._id, status: "active" });
  const subject = await Subject.create({ name: "Review Subject", collegeId: college._id, academicYearId: year._id, termId: term._id });
  const placement = { collegeId: college._id, academicYearId: year._id, phone: "+201234567890" };
  const students = await User.insertMany(Array.from({ length: 2000 }, (_, i) => ({
    ...placement, fullName: `Student ${i}`, email: `student${i}@review.test`, passwordHash, role: "student",
  })));
  const student = students[0]!;
  const packages = await Package.insertMany(Array.from({ length: 60 }, (_, i) => ({
    ...placement, phone: undefined, name: `Package ${i}`, termId: term._id,
    price: i < 50 ? 0 : 35000, isFree: i < 50, status: "active", description: "Review package",
  })).map(({ phone: _phone, ...row }) => row));
  const subjects = await PackageSubject.insertMany(packages.map(pkg => ({ packageId: pkg._id, subjectId: subject._id })));
  const publishedAt = new Date(Date.now() - 86400000);
  const lectures = await Lecture.insertMany(subjects.flatMap(ps => Array.from({ length: 20 }, (_, i) => ({
    packageSubjectId: ps._id, title: `Lecture ${i}`, order: i, status: "published", publishedAt,
    createdBy: admin._id, updatedBy: admin._id,
  }))));
  await Material.create({ lectureId: lectures[0]!._id, title: "Notes", type: "text", body: "x".repeat(4000) });
  await PackageAccess.insertMany([
    ...packages.slice(0, 50).map(pkg => ({ studentId: student._id, packageId: pkg._id, source: "free", status: "active", grantedAt: publishedAt })),
    ...students.slice(1).map(s => ({ studentId: s._id, packageId: packages[0]!._id, source: "free", status: "active", grantedAt: publishedAt })),
  ]);
  await LectureProgress.insertMany(lectures.slice(0, 200).map(l => ({ studentId: student._id, packageId: packages[0]!._id,
    packageSubjectId: l.packageSubjectId, lectureId: l._id, completedAt: publishedAt })));
  await StaffAssignment.create({ userId: lecturer._id, scopeType: "package_subject", packageId: packages[0]!._id,
    packageSubjectId: subjects[0]!._id, permissions: ["content:view"] });
  const receiptImage = `data:image/png;base64,${Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), Buffer.alloc(128 * 1024 - 8, 1)]).toString("base64")}`;
  const historyDate = new Date("2025-01-01T00:00:00Z");
  await Order.insertMany(Array.from({ length: 5000 }, (_, i) => ({
    studentId: students[i % students.length]!._id, packageId: packages[50]!._id, priceSnapshot: 35000,
    status: i < 20 ? "pending" : "completed", completedAt: i < 20 ? undefined : historyDate,
    receiptImage: i < 20 ? receiptImage : undefined,
  })));
  await Expense.insertMany(Array.from({ length: 5000 }, (_, i) => ({ createdBy: lecturer._id, category: "Review",
    amount: 10000, date: i < 20 ? new Date() : historyDate, notes: "Review expense", receiptImage: i < 20 ? receiptImage : undefined })));
  const agents = { admin: request.agent(app), student: request.agent(app), lecturer: request.agent(app) };
  const emails = { admin: "admin@review.test", student: "student0@review.test", lecturer: "lecturer@review.test" };
  for (const key of ["admin", "student", "lecturer"] as const)
    await agents[key].post("/api/v1/auth/login").send({ email: emails[key], password }).expect(200);
  const metrics: unknown[] = [];
  async function measure(name: string, run: () => PromiseLike<request.Response>) {
    await run(); // warmup
    const samples = [];
    const fieldBytes: Record<string, number> = {};
    for (let i = 0; i < 5; i++) {
      operations.length = 0; commands.length = 0;
      collecting = true;
      const start = performance.now();
      const response = await run();
      const milliseconds = performance.now() - start;
      collecting = false;
      if (response.status !== 200) throw new Error(`${name}: HTTP ${response.status}`);
      if (i === 0) {
        const body = response.body as { data?: unknown };
        const data = body.data;
        const rows = Array.isArray(data) ? data : data && typeof data === "object" && "expenses" in data
          ? (data as { expenses: unknown[] }).expenses : [];
        for (const row of rows) if (row && typeof row === "object")
          for (const [key, value] of Object.entries(row)) fieldBytes[key] = (fieldBytes[key] ?? 0) + Buffer.byteLength(JSON.stringify(value));
      }
      samples.push({ milliseconds, operations: operations.slice(), commands: commands.slice(), bytes: Buffer.isBuffer(response.body) ? response.body.length : Buffer.byteLength(response.text) });
    }
    const times = samples.map(s => s.milliseconds).sort((a, b) => a - b);
    metrics.push({ name, fieldValueBytes: fieldBytes, medianMs: Number(times[2]!.toFixed(2)), minMs: Number(times[0]!.toFixed(2)),
      maxMs: Number(times[4]!.toFixed(2)), databaseOperations: samples.map(s => s.operations.length),
      commands: samples[0]!.commands, commandCounts: samples.map(s => s.commands.length),
      operations: samples[0]!.operations, payloadBytes: samples.map(s => s.bytes) });
  }
  await measure("login", () => agents.admin.post("/api/v1/auth/login").send({ email: emails.admin, password }));
  const from = new Date(Date.now() - 7 * 86400000).toISOString();
  const to = new Date(Date.now() + 86400000).toISOString();
  for (const [name, actor, path] of [
    ["me", "student", "/auth/me"], ["timeline", "student", `/student/timeline?from=${from}&to=${to}`],
    ["learning", "student", "/student/packages"], ["explore", "student", "/student/packages?mode=explore"],
    ["package", "student", `/student/packages/${packages[0]!._id}`],
    ["lecture", "student", `/student/lectures/${lectures[0]!._id}`],
    ["dashboard", "admin", "/staff/dashboard"], ["users", "admin", "/admin/users?role=student"],
    ["users-deep", "admin", "/admin/users?role=student&page=100"],
    ["orders", "admin", "/admin/orders"], ["lecturer-students", "lecturer", "/staff/students"],
    ["finance", "admin", "/staff/finance"],
  ] as const) await measure(name, () => agents[actor].get(`/api/v1${path}`));
  const expense = await Expense.findOne({ receiptImage: { $exists: true } }).select("_id").lean();
  const order = await Order.findOne({ status: "pending" }).select("_id").lean();
  if (phase !== "baseline") {
    await measure("expense-receipt", () => agents.lecturer.get(`/api/v1/staff/expenses/${expense!._id}/receipt`));
    await measure("order-receipt", () => agents.admin.get(`/api/v1/admin/orders/${order!._id}/receipt`));
  }
  const explanations = [];
  for (const [name, query] of [
    ["users-first", User.find({ role: "student" }).sort({ createdAt: -1, _id: -1 }).limit(20)],
    ["users-deep", User.find({ role: "student" }).sort({ createdAt: -1, _id: -1 }).skip(1980).limit(20)],
    ["orders", Order.find({ status: "pending" }).sort({ createdAt: -1, _id: -1 }).limit(20)],
    ["expenses", Expense.find().sort({ date: -1, _id: -1 }).limit(20)],
    ["scheduled", Lecture.find({ status: "scheduled", scheduledAt: { $lte: new Date() } })],
  ] as const) {
    const result = await query.explain("executionStats") as unknown as { executionStats: unknown; queryPlanner: { winningPlan: unknown } };
    explanations.push({ name, stats: result.executionStats, winningPlan: result.queryPlanner.winningPlan });
  }
  for (const [name, model, pipeline] of [
    ["revenue-history", Order, [{ $match: { status: "completed" } }, { $group: { _id: null, amount: { $sum: "$priceSnapshot" } } }]],
    ["expense-history", Expense, [{ $group: { _id: null, amount: { $sum: "$amount" } } }]],
  ] as const) explanations.push({ name, explain: await model.aggregate([...pipeline]).explain("executionStats") });
  const due = await Lecture.insertMany(Array.from({ length: 100 }, (_, i) => ({ packageSubjectId: subjects[0]!._id,
    title: `Due ${i}`, status: "scheduled", scheduledAt: publishedAt, createdBy: admin._id, updatedBy: admin._id })));
  operations.length = 0; commands.length = 0; collecting = true;
  const start = performance.now(); await publishScheduled(); collecting = false;
  const scheduled = { lectures: due.length, milliseconds: Number((performance.now() - start).toFixed(2)),
    databaseOperations: operations.length, databaseCommands: commands.length, operations: operations.slice() };
  const output = { phase, fixture: { students: 2000, packages: 60, ownedPackages: 50, lectures: 1200,
    orders: 5000, expenses: 5000, inlineReceiptBytes: 128 * 1024, samples: 5, bcryptCost: 12 }, metrics, explanations, scheduled };
  await mkdir("artifacts/performance-review", { recursive: true });
  await writeFile(`artifacts/performance-review/${phase}.json`, JSON.stringify(output, null, 2));
  console.log(JSON.stringify({ phase, metrics, scheduled: { ...scheduled, operations: undefined } }, null, 2));
} finally {
  collecting = false;
  assert.equal(mongoose.connection.name, database, "Refusing cleanup of an unexpected database");
  assert.match(database, /^ep_rebuild_test_performance_/);
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
}
