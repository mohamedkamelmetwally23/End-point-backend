// Read-only verification of the committed curriculum reset.
import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connect } from "../src/shared/database.js";
import { academicCurriculum } from "./seeds/academic-curriculum.js";
await connect();
try {
  const db = mongoose.connection.db!;
  const counts: Record<string, number> = {};
  for (const name of [
    "colleges",
    "users",
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
    "expenses",
    "lecture_progress",
    "audit_logs",
    "student_devices",
    "sessions",
  ])
    counts[name] = await db.collection(name).countDocuments();
  assert.equal(counts.academic_years, 4);
  assert.equal(counts.terms, 8);
  assert.equal(counts.subjects, 48);
  for (const name of [
    "packages",
    "package_subjects",
    "lectures",
    "materials",
    "staff_assignments",
    "package_access",
    "orders",
    "expenses",
    "lecture_progress",
  ])
    assert.equal(counts[name], 0);
  const semesters = [];
  const terms = await db
    .collection("terms")
    .find({})
    .sort({ order: 1 })
    .toArray();
  for (const [index, term] of terms.entries()) {
    const year = await db
      .collection("academic_years")
      .findOne({ _id: term.academicYearId });
    assert.ok(year);
    assert.equal(year.order, Math.floor(index / 2) + 1);
    assert.equal(term.order, index + 1);
    assert.equal(term.localOrder, (index % 2) + 1);
    assert.equal(term.status, "inactive");
    assert.ok(await db.collection("colleges").findOne({ _id: year.collegeId }));
    const subjects = await db
      .collection("subjects")
      .find({ termId: term._id })
      .toArray();
    assert.deepEqual(
      subjects.map((row) => row.name).sort(),
      [...academicCurriculum[index]!].sort(),
    );
    assert.ok(
      subjects.every(
        (row) =>
          String(row.academicYearId) === String(year._id) &&
          String(row.collegeId) === String(year.collegeId) &&
          row.status === "active",
      ),
    );
    semesters.push({ name: term.name, subjects: subjects.length });
  }
  assert.equal(
    await db
      .collection("users")
      .countDocuments({ academicYearId: { $exists: true } }),
    0,
  );
  const revenue = await db
    .collection("orders")
    .aggregate([
      { $match: { status: "completed" } },
      { $group: { _id: null, revenue: { $sum: "$priceSnapshot" } } },
    ])
    .toArray();
  console.log(
    JSON.stringify(
      {
        database: mongoose.connection.name,
        counts,
        semesters,
        revenue: revenue[0]?.revenue ?? 0,
        validation: "PASS: committed database checked independently",
      },
      null,
      2,
    ),
  );
} finally {
  await mongoose.disconnect();
}
