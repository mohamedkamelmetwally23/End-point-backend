/** TEST/DEVELOPMENT ONLY. Never drops the database or deletes users/colleges. */
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { connect, transaction } from "../src/shared/database.js";
import {
  models,
  AcademicYear,
  Term,
  Subject,
} from "../src/modules/domain/models.js";
import { confirmedTestDatabase } from "./database-tools.js";
import { academicCurriculum } from "./seeds/academic-curriculum.js";

const clearedCollections = [
  "academic_years",
  "terms",
  "subjects",
  "packages",
  "package_subjects",
  "lectures",
  "materials",
  "staff_assignments",
  "package_access",
  "orders",
  "lecture_progress",
  "expenses",
] as const;
const academicFields = [
  "academicYearId",
  "termId",
  "semesterId",
  "subjectId",
  "packageId",
  "packageSubjectId",
  "lectureId",
  "accessId",
  "packageAccessId",
];
await connect();
try {
  confirmedTestDatabase(mongoose.connection.name, env.NODE_ENV);
  assert.ok(
    process.argv.includes("--reset-test-academic"),
    "Explicit TEST reset flag required",
  );
  assert.equal(academicCurriculum.length, 8);
  assert.ok(academicCurriculum.every((subjects) => subjects.length === 6));
  const db = mongoose.connection.db!;
  const names = (await db.listCollections().toArray()).map((c) => c.name);
  assert.deepEqual(
    names.filter((name) => !(name in models)),
    [],
    "Unknown collections require inspection before resetting",
  );
  // All writes and preservation checks are atomic; unsupported transactions fail before deletion.
  const summary = await transaction(async (session) => {
    const colleges = await db
      .collection("colleges")
      .find({}, { session })
      .sort({ _id: 1 })
      .toArray();
    assert.equal(
      colleges.length,
      1,
      "Expected exactly one existing college; ambiguous college selection",
    );
    const college = colleges[0]!;
    const users = await db
      .collection("users")
      .find({}, { session })
      .sort({ _id: 1 })
      .toArray();
    const deletedIds = new Set<string>();
    for (const name of clearedCollections) {
      for (const row of await db
        .collection(name)
        .find({}, { session, projection: { _id: 1 } })
        .toArray())
        deletedIds.add(String(row._id));
    }
    const containsDeletedId = (value: unknown): boolean => {
      if (value instanceof mongoose.Types.ObjectId || typeof value === "string")
        return deletedIds.has(String(value));
      if (Array.isArray(value)) return value.some(containsDeletedId);
      return (
        !!value &&
        typeof value === "object" &&
        Object.values(value).some(containsDeletedId)
      );
    };
    const deleted: Record<string, number> = {};
    const logs = await db
      .collection("audit_logs")
      .find({}, { session })
      .toArray();
    const relatedLogs = logs.filter(
      (log) =>
        (clearedCollections as readonly string[]).includes(log.entityType) ||
        containsDeletedId(log.entityId) ||
        containsDeletedId(log.metadata),
    );
    deleted.audit_logs = (
      await db
        .collection("audit_logs")
        .deleteMany(
          { _id: { $in: relatedLogs.map((log) => log._id) } },
          { session },
        )
    ).deletedCount;
    // Devices in the current schema are bound only to preserved users. Remove only legacy academic-bound records.
    const devices = await db
      .collection("student_devices")
      .find({}, { session })
      .toArray();
    const oldDevices = devices.filter((device) =>
      academicFields.some((field) => device[field] != null),
    );
    deleted.student_devices = (
      await db
        .collection("student_devices")
        .deleteMany(
          { _id: { $in: oldDevices.map((device) => device._id) } },
          { session },
        )
    ).deletedCount;
    const userReferencesCleared: Array<{ userId: string; fields: string[] }> =
      [];
    for (const user of users) {
      const fields = academicFields.filter((field) => user[field] != null);
      if (!fields.length) continue;
      await db
        .collection("users")
        .updateOne(
          { _id: user._id },
          { $unset: Object.fromEntries(fields.map((field) => [field, ""])) },
          { session },
        );
      userReferencesCleared.push({ userId: String(user._id), fields });
      // Expected snapshot differs only in explicitly cleared placement/access fields.
      for (const field of fields) delete user[field];
    }
    for (const name of clearedCollections)
      deleted[name] = (
        await db.collection(name).deleteMany({}, { session })
      ).deletedCount;
    const semesters = [];
    for (let yearNumber = 1; yearNumber <= 4; yearNumber++) {
      const [year] = await AcademicYear.create(
        [
          {
            collegeId: college._id,
            name: `Year ${yearNumber}`,
            order: yearNumber,
            status: "active",
          },
        ],
        { session },
      );
      for (let localOrder = 1; localOrder <= 2; localOrder++) {
        const order = (yearNumber - 1) * 2 + localOrder;
        const [term] = await Term.create(
          [
            {
              academicYearId: year!._id,
              name: `Semester ${order}`,
              order,
              localOrder,
              status: "inactive",
            },
          ],
          { session },
        );
        const expectedNames = academicCurriculum[order - 1]!;
        await Subject.create(
          expectedNames.map((name) => ({
            name,
            collegeId: college._id,
            academicYearId: year!._id,
            termId: term!._id,
            status: "active",
          })),
          { session, ordered: true },
        );
        const actual = await Subject.find({ termId: term!._id })
          .session(session)
          .lean();
        assert.deepEqual(
          actual.map((row) => row.name).sort(),
          [...expectedNames].sort(),
        );
        assert.ok(
          actual.every(
            (row) =>
              String(row.collegeId) === String(college._id) &&
              String(row.academicYearId) === String(year!._id) &&
              row.status === "active",
          ),
        );
        semesters.push({
          name: term!.name,
          year: yearNumber,
          order,
          localOrder,
          subjects: actual.length,
          status: term!.status,
        });
      }
    }
    assert.deepEqual(
      await db
        .collection("colleges")
        .find({}, { session })
        .sort({ _id: 1 })
        .toArray(),
      colleges,
    );
    assert.deepEqual(
      await db
        .collection("users")
        .find({}, { session })
        .sort({ _id: 1 })
        .toArray(),
      users,
    );
    const counts: Record<string, number> = {};
    for (const name of clearedCollections)
      counts[name] = await db.collection(name).countDocuments({}, { session });
    assert.equal(counts.academic_years, 4);
    assert.equal(counts.terms, 8);
    assert.equal(counts.subjects, 48);
    for (const name of clearedCollections.filter(
      (name) => !["academic_years", "terms", "subjects"].includes(name),
    ))
      assert.equal(counts[name], 0);
    assert.equal(
      await db
        .collection("users")
        .countDocuments(
          {
            $or: academicFields.map((field) => ({
              [field]: { $exists: true },
            })),
          },
          { session },
        ),
      0,
    );
    return {
      database: mongoose.connection.name,
      environment: env.NODE_ENV,
      collegePreserved: { id: String(college._id), name: college.name },
      usersPreserved: users.length,
      deleted,
      counts,
      semesters,
      userReferencesCleared,
      revenue: 0,
      validation:
        "All assertions passed inside transaction; committed atomically",
    };
  });
  console.log(JSON.stringify(summary, null, 2));
} finally {
  await mongoose.disconnect();
}
