import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connect, transaction } from "../src/shared/database.js";
import { env } from "../src/config/env.js";
import { confirmedTestDatabase } from "./database-tools.js";
import { activateFirstTerm } from "./activate-first-term.js";
import { activeTerm } from "../src/modules/academics/service.js";
import {
  listPackages,
  packageDetail,
} from "../src/modules/packages/service.js";
import {
  User,
  College,
  AcademicYear,
  Term,
  Package,
  PackageAccess,
} from "../src/modules/domain/models.js";
await connect();
try {
  confirmedTestDatabase(mongoose.connection.name, env.NODE_ENV);
  assert.ok(
    process.argv.includes("--apply-test-first-term"),
    "Explicit TEST update flag required",
  );
  const db = mongoose.connection.db!;
  const preserved = [
    "colleges",
    "users",
    "lectures",
    "materials",
    "package_access",
    "staff_assignments",
  ];
  const change = await transaction(async (session) => {
    const before: Record<string, unknown> = {};
    for (const name of preserved)
      before[name] = await db
        .collection(name)
        .find({}, { session })
        .sort({ _id: 1 })
        .toArray();
    const result = await activateFirstTerm(session);
    for (const name of preserved)
      assert.deepEqual(
        await db
          .collection(name)
          .find({}, { session })
          .sort({ _id: 1 })
          .toArray(),
        before[name],
      );
    return result;
  });
  const pkg = await Package.findById(change.packageId).lean();
  const students = await User.find({
    role: "student",
    collegeId: change.collegeId,
    academicYearId: change.yearId,
  }).lean();
  assert.ok(students.length, "Expected Year 3 test student");
  const studentResults = [];
  for (const student of students) {
    const principal = {
      userId: String(student._id),
      role: "student",
      collegeId: String(student.collegeId),
      academicYearId: String(student.academicYearId),
    };
    const term = await activeTerm(
      principal.collegeId,
      principal.academicYearId,
    );
    const access = await PackageAccess.find({ studentId: student._id }).lean();
    const owned = access.some(
      (a) => String(a.packageId) === change.packageId && a.status === "active",
    );
    const explore = await listPackages(principal, "explore");
    const learning = await listPackages(principal, "learning");
    const visible = explore.some((p) => String(p._id) === change.packageId);
    assert.equal(visible, !owned);
    assert.equal(
      learning.some((p) => String(p._id) === change.packageId),
      owned,
    );
    const detail = await packageDetail(principal, change.packageId, !owned);
    studentResults.push({
      studentId: String(student._id),
      name: student.fullName,
      collegeId: principal.collegeId,
      academicYearId: principal.academicYearId,
      resolvedSemester: { id: String(term._id), name: term.name },
      packageAccess: access.map((a) => ({
        id: String(a._id),
        packageId: String(a.packageId),
        status: a.status,
      })),
      eligibility: {
        college: true,
        year: true,
        semester: true,
        packageActive: pkg?.status === "active",
        containsActiveSubjects: detail.subjects.length > 0,
        alreadyOwned: owned,
      },
      explore: visible ? "VISIBLE" : "HIDDEN",
      reason: owned ? "Already has active PackageAccess" : null,
      myLearning: owned ? "VISIBLE" : "HIDDEN",
    });
  }
  console.log(
    JSON.stringify(
      {
        database: mongoose.connection.name,
        change,
        college: await College.findById(change.collegeId).select("name"),
        year: await AcademicYear.findById(change.yearId).select("name"),
        terms: await Term.find()
          .sort({ order: 1 })
          .select("name order localOrder status academicYearId"),
        package: pkg,
        students: studentResults,
        preserved: await Promise.all(
          preserved.map(async (name) => ({
            collection: name,
            count: await db.collection(name).countDocuments(),
          })),
        ),
        validation:
          "PASS: transaction preservation and independent canonical service checks",
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
