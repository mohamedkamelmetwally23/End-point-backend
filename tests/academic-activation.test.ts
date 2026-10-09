import { beforeAll, afterAll, it, expect } from "vitest";
import mongoose from "mongoose";
import { env } from "../src/config/env.js";
import { confirmedTestDatabase } from "../scripts/database-tools.js";
import {
  activateFirstTerm,
  availableSubjectNames,
} from "../scripts/activate-first-term.js";
import { academicCurriculum } from "../scripts/seeds/academic-curriculum.js";
import { transaction } from "../src/shared/database.js";
import { activeTerm } from "../src/modules/academics/service.js";
import {
  listPackages,
  packageDetail,
  lectureDetail,
  studentPackage,
} from "../src/modules/packages/service.js";
import { timeline } from "../src/modules/progress/service.js";
import {
  models,
  College,
  AcademicYear,
  Term,
  Subject,
  Package,
  PackageSubject,
  User,
  PackageAccess,
  Lecture,
  Material,
} from "../src/modules/domain/models.js";
const database = `ep_rebuild_test_a_${Date.now()}`;
beforeAll(async () => {
  await mongoose.connect(env.MONGODB_URI, { dbName: database });
  confirmedTestDatabase(mongoose.connection.name, "test");
  await Promise.all(Object.values(models).map((m) => m.init()));
}, 30000);
afterAll(async () => {
  if (mongoose.connection.readyState) {
    confirmedTestDatabase(mongoose.connection.name, "test");
    await mongoose.connection.dropDatabase();
    await mongoose.disconnect();
  }
}, 30000);
it("activates first terms per year and enforces Explore, ownership and published active subject content", async () => {
  const college = await College.create({ name: "Curriculum" });
  const years = await AcademicYear.create(
    [1, 2, 3, 4].map((order) => ({
      name: `Year ${order}`,
      collegeId: college._id,
      order,
    })),
  );
  const terms = await Term.create(
    Array.from({ length: 8 }, (_, index) => ({
      name: `Semester ${index + 1}`,
      academicYearId: years[Math.floor(index / 2)]!._id,
      order: index + 1,
      localOrder: (index % 2) + 1,
      status: "inactive",
    })),
  );
  const subjects = await Subject.create(
    academicCurriculum.flatMap((names, index) =>
      names.map((name) => ({
        name,
        collegeId: college._id,
        academicYearId: years[Math.floor(index / 2)]!._id,
        termId: terms[index]!._id,
      })),
    ),
  );
  const target = subjects.filter((s) => availableSubjectNames.includes(s.name));
  const pkg = await Package.create({
    name: "Existing first term",
    collegeId: college._id,
    academicYearId: years[2]!._id,
    termId: terms[4]!._id,
    isFree: true,
    price: 0,
    status: "active",
  });
  const links = await PackageSubject.create(
    target.map((s) => ({ packageId: pkg._id, subjectId: s._id })),
  );
  const change = await transaction(activateFirstTerm);
  expect(change.packageId).toBe(String(pkg._id));
  expect(await Package.countDocuments()).toBe(1);
  expect(await Subject.countDocuments()).toBe(48);
  expect(
    (await Subject.find({ status: "active" })).map((s) => s.name).sort(),
  ).toEqual([...availableSubjectNames].sort());
  expect(await Subject.countDocuments({ status: "inactive" })).toBe(46);
  for (let i = 0; i < 4; i++) {
    expect(String((await activeTerm(college._id, years[i]!._id))._id)).toBe(
      String(terms[i * 2]!._id),
    );
    expect((await Term.findById(terms[i * 2 + 1]!._id))?.status).toBe(
      "inactive",
    );
  }
  const student = await User.create({
    fullName: "Year 3",
    email: "activation@test.local",
    passwordHash: "fixture",
    role: "student",
    phone: "123456789",
    collegeId: college._id,
    academicYearId: years[2]!._id,
  });
  const principal = {
    userId: String(student._id),
    role: "student",
    collegeId: String(college._id),
    academicYearId: String(years[2]!._id),
  };
  const ids = (rows: Awaited<ReturnType<typeof listPackages>>) =>
    rows.map((p) => String(p._id));
  expect(ids(await listPackages(principal, "explore"))).toContain(
    String(pkg._id),
  );
  await Subject.updateOne(
    { _id: target[1]!._id },
    { $set: { status: "inactive" } },
  );
  const mixed = await listPackages(principal, "explore");
  expect(ids(mixed)).toContain(String(pkg._id));
  expect(
    mixed.find((row) => String(row._id) === String(pkg._id))?.subjects,
  ).toHaveLength(1);
  await Subject.updateOne(
    { _id: target[1]!._id },
    { $set: { status: "active" } },
  );
  const second = await Package.create({
    name: "Semester 6",
    collegeId: college._id,
    academicYearId: years[2]!._id,
    termId: terms[5]!._id,
    isFree: true,
    price: 0,
    status: "active",
  });
  await PackageSubject.create({
    packageId: second._id,
    subjectId: target[0]!._id,
  });
  expect(ids(await listPackages(principal, "explore"))).not.toContain(
    String(second._id),
  );
  expect(
    ids(
      await listPackages(
        { ...principal, academicYearId: String(years[1]!._id) },
        "explore",
      ),
    ),
  ).not.toContain(String(pkg._id));
  const other = await College.create({ name: "Another college" });
  const otherYear = await AcademicYear.create({
    name: "Year 3",
    collegeId: other._id,
    order: 3,
  });
  await Term.create({
    name: "First term",
    academicYearId: otherYear._id,
    status: "active",
  });
  expect(
    ids(
      await listPackages(
        {
          ...principal,
          collegeId: String(other._id),
          academicYearId: String(otherYear._id),
        },
        "explore",
      ),
    ),
  ).not.toContain(String(pkg._id));
  await PackageAccess.create({
    studentId: student._id,
    packageId: pkg._id,
    source: "free",
    status: "active",
    grantedAt: new Date(),
  });
  expect(ids(await listPackages(principal, "explore"))).not.toContain(
    String(pkg._id),
  );
  expect(ids(await listPackages(principal, "learning"))).toContain(
    String(pkg._id),
  );
  const inactive = subjects.find((s) => s.name === "Operating Systems")!;
  const inactiveLink = await PackageSubject.create({
    packageId: pkg._id,
    subjectId: inactive._id,
  });
  const empty = await Package.create({
    name: "Only inactive subjects",
    collegeId: college._id,
    academicYearId: years[2]!._id,
    termId: terms[4]!._id,
    isFree: true,
    price: 0,
    status: "active",
  });
  await PackageSubject.create({
    packageId: empty._id,
    subjectId: inactive._id,
  });
  expect(ids(await listPackages(principal, "explore"))).not.toContain(
    String(empty._id),
  );
  await expect(studentPackage(principal, empty._id, false)).rejects.toThrow();
  const past = new Date(Date.now() - 60000),
    future = new Date(Date.now() + 86400000);
  const lecture = await Lecture.create({
    packageSubjectId: links[0]!._id,
    title: "Visible",
    status: "published",
    publishedAt: past,
    createdBy: student._id,
    updatedBy: student._id,
  });
  const hidden = await Lecture.create(
    [
      { packageSubjectId: links[0]!._id, title: "Draft", status: "draft" },
      {
        packageSubjectId: links[0]!._id,
        title: "Scheduled",
        status: "scheduled",
        scheduledAt: future,
      },
      {
        packageSubjectId: links[0]!._id,
        title: "Archived",
        status: "archived",
      },
      {
        packageSubjectId: links[0]!._id,
        title: "Future published",
        status: "published",
        publishedAt: future,
      },
      {
        packageSubjectId: inactiveLink._id,
        title: "Inactive subject",
        status: "published",
        publishedAt: past,
      },
      {
        packageSubjectId: links[1]!._id,
        title: "Archived link",
        status: "published",
        publishedAt: past,
      },
    ].map((row) => ({
      ...row,
      createdBy: student._id,
      updatedBy: student._id,
    })),
  );
  await PackageSubject.updateOne(
    { _id: links[1]!._id },
    { $set: { status: "archived" } },
  );
  await Material.create({
    lectureId: lecture._id,
    title: "Accessible",
    type: "text",
    body: "Visible material",
  });
  for (const row of hidden)
    await Material.create({
      lectureId: row._id,
      title: "Hidden",
      type: "text",
      body: "Hidden material",
    });
  const detail = await packageDetail(principal, String(pkg._id));
  expect(detail.subjects.map((s) => String(s._id))).toEqual([
    String(links[0]!._id),
  ]);
  expect(detail.lectures.map((l) => String(l._id))).toEqual([
    String(lecture._id),
  ]);
  expect(
    (await lectureDetail(principal, String(lecture._id))).materials,
  ).toHaveLength(1);
  for (const row of hidden)
    await expect(lectureDetail(principal, String(row._id))).rejects.toThrow();
  expect(
    (
      await timeline(
        principal,
        new Date(Date.now() - 86400000).toISOString(),
        future.toISOString(),
      )
    ).map((l) => String(l._id)),
  ).toEqual([String(lecture._id)]);
}, 120000);
