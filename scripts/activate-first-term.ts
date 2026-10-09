import assert from "node:assert/strict";
import { type ClientSession } from "mongoose";
import {
  College,
  AcademicYear,
  Term,
  Subject,
  Package,
  PackageSubject,
} from "../src/modules/domain/models.js";
export const availableSubjectNames = [
  "Digital Signal Processing",
  "Computer Organization",
];
// Focused update: no deletions, inserts, user placement changes, or content edits.
export async function activateFirstTerm(session: ClientSession) {
  const colleges = await College.find().session(session).lean();
  assert.equal(colleges.length, 1, "Ambiguous existing college");
  const college = colleges[0]!;
  const years = await AcademicYear.find({ collegeId: college._id })
    .sort({ order: 1 })
    .session(session)
    .lean();
  assert.deepEqual(
    years.map((y) => y.order),
    [1, 2, 3, 4],
  );
  const terms = await Term.find({
    academicYearId: { $in: years.map((y) => y._id) },
  })
    .session(session)
    .lean();
  assert.equal(terms.length, 8);
  const firstTerms = years.map((year) => {
    const pair = terms
      .filter((term) => String(term.academicYearId) === String(year._id))
      .sort((a, b) => a.localOrder - b.localOrder);
    assert.deepEqual(
      pair.map((t) => t.localOrder),
      [1, 2],
    );
    assert.deepEqual(
      pair.map((t) => t.order),
      [year.order * 2 - 1, year.order * 2],
    );
    return pair[0]!;
  });
  const year = years[2]!;
  const term = firstTerms[2]!;
  const subjects = await Subject.find({ name: { $in: availableSubjectNames } })
    .session(session)
    .lean();
  assert.equal(subjects.length, 2, "Expected existing unique subjects");
  assert.deepEqual(
    subjects.map((s) => s.name).sort(),
    [...availableSubjectNames].sort(),
  );
  const links = await PackageSubject.find({
    subjectId: { $in: subjects.map((s) => s._id) },
  })
    .session(session)
    .lean();
  const candidates = await Package.find({
    _id: { $in: links.map((l) => l.packageId) },
  })
    .session(session)
    .lean();
  const matches = candidates.filter((pkg) =>
    subjects.every((subject) =>
      links.some(
        (link) =>
          String(link.packageId) === String(pkg._id) &&
          String(link.subjectId) === String(subject._id),
      ),
    ),
  );
  assert.equal(
    matches.length,
    1,
    "Expected one existing package containing both subjects",
  );
  const pkg = matches[0]!;
  const corrections = {
    package: ["collegeId", "academicYearId", "termId", "status"].filter(
      (key) =>
        String(pkg[key as keyof typeof pkg]) !==
        String(
          (
            {
              collegeId: college._id,
              academicYearId: year._id,
              termId: term._id,
              status: "active",
            } as Record<string, unknown>
          )[key],
        ),
    ),
    subjects: subjects
      .filter(
        (s) =>
          String(s.collegeId) !== String(college._id) ||
          String(s.academicYearId) !== String(year._id) ||
          String(s.termId) !== String(term._id),
      )
      .map((s) => String(s._id)),
  };
  const termOff = await Term.updateMany(
    { _id: { $in: terms.map((t) => t._id) }, status: { $ne: "inactive" } },
    { $set: { status: "inactive" } },
    { session },
  );
  const termOn = await Term.updateMany(
    { _id: { $in: firstTerms.map((t) => t._id) } },
    { $set: { status: "active" } },
    { session },
  );
  const subjectOff = await Subject.updateMany(
    { _id: { $nin: subjects.map((s) => s._id) }, status: { $ne: "inactive" } },
    { $set: { status: "inactive" } },
    { session },
  );
  const subjectOn = await Subject.updateMany(
    { _id: { $in: subjects.map((s) => s._id) } },
    {
      $set: {
        collegeId: college._id,
        academicYearId: year._id,
        termId: term._id,
        status: "active",
      },
    },
    { session },
  );
  await Package.updateOne(
    { _id: pkg._id },
    {
      $set: {
        collegeId: college._id,
        academicYearId: year._id,
        termId: term._id,
        status: "active",
      },
    },
    { session },
  );
  const packageSubjects = await PackageSubject.updateMany(
    { packageId: pkg._id, subjectId: { $in: subjects.map((s) => s._id) } },
    { $set: { status: "active" } },
    { session },
  );
  assert.equal(
    await Subject.countDocuments({ status: "active" }).session(session),
    2,
  );
  assert.equal(
    await Subject.countDocuments({ status: "inactive" }).session(session),
    46,
  );
  return {
    collegeId: String(college._id),
    yearId: String(year._id),
    termId: String(term._id),
    packageId: String(pkg._id),
    corrections,
    updated: {
      termsDeactivated: termOff.modifiedCount,
      termsActivated: termOn.modifiedCount,
      subjectsDeactivated: subjectOff.modifiedCount,
      subjectsActivated: subjectOn.modifiedCount,
      packageSubjects: packageSubjects.modifiedCount,
    },
    semesters: firstTerms.map((t) => ({
      id: String(t._id),
      order: t.order,
      status: "active",
    })),
    subjects: subjects.map((s) => ({
      id: String(s._id),
      name: s.name,
      status: "active",
    })),
  };
}
