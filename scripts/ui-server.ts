import mongoose from "mongoose";
import "dotenv/config";
import bcrypt from "bcryptjs";
import express from "express";
const database = `ep_rebuild_test_ui_${Date.now()}`;
process.env.NODE_ENV = "test";
process.env.PORT = "4001";
process.env.FRONTEND_URL = "http://127.0.0.1:4175";
process.env.WHATSAPP_NUMBER = "201234567890";
const { env } = await import("../src/config/env.js");
const { app } = await import("../src/app.js");
const {
  models,
  User,
  College,
  AcademicYear,
  Term,
  Subject,
  Package,
  PackageSubject,
  Lecture,
  Material,
  StaffAssignment,
} = await import("../src/modules/domain/models.js");
const { confirmedTestDatabase } = await import("./database-tools.js");
await mongoose.connect(env.MONGODB_URI, { dbName: database });
confirmedTestDatabase(mongoose.connection.name, "test");
for (const model of Object.values(models)) {
  await model.createCollection();
  await model.syncIndexes();
}
const passwordHash = await bcrypt.hash("Browser-test-password!", 4);
const admin = await User.create({
  fullName: "Test Administrator",
  email: "admin@browser.test",
  passwordHash,
  role: "super_admin",
});
const manager = await User.create({
  fullName: "Content Manager",
  email: "manager@browser.test",
  passwordHash,
  role: "content_manager",
});
const lecturer = await User.create({
  fullName: "Lecturer",
  email: "lecturer@browser.test",
  passwordHash,
  role: "lecturer",
});
const college = await College.create({
  name: "Faculty of Computing",
  code: "computing",
});
const year = await AcademicYear.create({
  name: "Foundation Year",
  collegeId: college._id,
});
const term = await Term.create({
  name: "Autumn Term",
  academicYearId: year._id,
  status: "active",
});
const subject = await Subject.create({
  name: "Algorithms",
  collegeId: college._id,
  academicYearId: year._id,
});
const other = await Subject.create({
  name: "Databases",
  collegeId: college._id,
});
const base = {
  collegeId: college._id,
  academicYearId: year._id,
  termId: term._id,
  status: "active",
  description: "Lectures and practical notes for your current term.",
};
const free = await Package.create({
  ...base,
  name: "Open Learning",
  isFree: true,
  price: 0,
});
await Package.create({
  ...base,
  name: "Complete Term",
  isFree: false,
  price: 35000,
});
const ps = await PackageSubject.create({
  packageId: free._id,
  subjectId: subject._id,
});
await PackageSubject.create({
  packageId: free._id,
  subjectId: other._id,
  order: 1,
});
const lecture = await Lecture.create({
  packageSubjectId: ps._id,
  title: "Thinking in algorithms",
  description: "An introduction to problem solving.",
  status: "published",
  publishedAt: new Date(),
  createdBy: admin._id,
  updatedBy: admin._id,
});
await Material.create({
  lectureId: lecture._id,
  title: "Getting started",
  type: "text",
  body: "Break the problem into small steps. Compare possible solutions.",
});
await StaffAssignment.create({
  userId: manager._id,
  scopeType: "package",
  packageId: free._id,
  permissions: ["content:view", "content:create", "content:edit"],
});
await StaffAssignment.create({
  userId: lecturer._id,
  scopeType: "package_subject",
  packageId: free._id,
  packageSubjectId: ps._id,
  permissions: ["content:view"],
});
const testApp = express();
testApp.post("/__test/cleanup", async (_req, res) => {
  confirmedTestDatabase(mongoose.connection.name, "test");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  res.json({ cleaned: true });
  server.close();
});
testApp.use(app);
const server = testApp.listen(4001, "127.0.0.1", () =>
  console.log("Browser test API ready"),
);
let shuttingDown = false;
async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close();
  if (!mongoose.connection.readyState) {
    process.exit(0);
    return;
  }
  confirmedTestDatabase(mongoose.connection.name, "test");
  await mongoose.connection.dropDatabase();
  await mongoose.disconnect();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
