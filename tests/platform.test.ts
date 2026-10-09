import { beforeAll, afterAll, describe, it, expect } from "vitest";
import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import request from "supertest";
import { env } from "../src/config/env.js";
import { app } from "../src/app.js";
import {
  models,
  User,
  College,
  Term,
  PackageSubject,
  Lecture,
  PackageAccess,
  Order,
  AuditLog,
  AcademicYear,
  Package,
  StudentDevice,
  Session,
  Material,
} from "../src/modules/domain/models.js";
import { confirmedTestDatabase, seedAdmin } from "../scripts/database-tools.js";
import {
  activeTerm,
  ensureAllYearTerms,
} from "../src/modules/academics/service.js";
import { publishScheduled } from "../src/modules/content/service.js";

describe("Platform rules against real MongoDB", () => {
  const database = `ep_rebuild_test_${Date.now()}`;
  const admin = request.agent(app),
    student = request.agent(app),
    lecturer = request.agent(app),
    manager = request.agent(app);
  let collegeId = "",
    yearId = "",
    termId = "",
    studentId = "",
    lecturerId = "",
    managerId = "",
    freeId = "",
    paidId = "",
    psId = "",
    lectureId = "",
    orderId = "",
    expenseId = "";
  const password = "Test-password-2026!";
  beforeAll(async () => {
    await mongoose.connect(env.MONGODB_URI, { dbName: database });
    confirmedTestDatabase(mongoose.connection.name, "test");
    for (const m of Object.values(models)) {
      await m.createCollection();
      await m.syncIndexes();
    }
    await User.create({
      fullName: "Admin",
      email: "admin@test.local",
      passwordHash: await bcrypt.hash(password, 4),
      role: "super_admin",
    });
    await admin
      .post("/api/v1/auth/login")
      .send({ email: "admin@test.local", password })
      .expect(200);
  }, 30000);
  afterAll(async () => {
    if (mongoose.connection.readyState) {
      confirmedTestDatabase(mongoose.connection.name, "test");
      await mongoose.connection.dropDatabase();
      await mongoose.disconnect();
    }
  }, 30000);
  const create = async (path: string, body: object) => {
    const response = await admin.post(`/api/v1${path}`).send(body);
    expect(response.status, response.text).toBe(200);
    return response.body.data;
  };
  it("creates the college/year/term hierarchy and resolves one active term", async () => {
    collegeId = (
      await create("/admin/academics/colleges", {
        name: "Computing",
        code: "cs",
      })
    )._id;
    yearId = (
      await create("/admin/academics/academic_years", {
        name: "Year A",
        collegeId,
      })
    )._id;
    termId = (
      await create("/admin/academics/terms", {
        name: "Autumn",
        academicYearId: yearId,
        status: "active",
      })
    )._id;
    const second = await create("/admin/academics/terms", {
      name: "Summer",
      academicYearId: yearId,
      status: "active",
    });
    expect(
      await Term.countDocuments({ academicYearId: yearId, status: "active" }),
    ).toBe(1);
    await admin
      .put(`/api/v1/admin/academics/terms/${termId}`)
      .send({ name: "Autumn", academicYearId: yearId, status: "active" })
      .expect(200);
    expect(String((await activeTerm(collegeId, yearId))._id)).toBe(termId);
    expect((await Term.findById(second._id))?.status).toBe("inactive");
  });
  it("creates numbered years with a college in one operation", async () => {
    const college = await create("/admin/academics/colleges", {
      name: "Four-year college",
      yearCount: 4,
    });
    const years = await AcademicYear.find({ collegeId: college._id }).sort({
      order: 1,
    });
    expect(years.map((year) => year.name)).toEqual(["1", "2", "3", "4"]);
    for (const year of years) {
      const terms = await Term.find({ academicYearId: year._id });
      expect(terms.map((term) => term.name).sort()).toEqual(
        ["الترم الأول", "الترم الثاني"].sort(),
      );
    }
    await ensureAllYearTerms();
    await ensureAllYearTerms();
    expect(
      await Term.countDocuments({
        academicYearId: { $in: years.map((year) => year._id) },
      }),
    ).toBe(8);
  });
  it("rejects legacy multipart uploads instead of writing local files or Base64", async () => {
    await admin.post("/api/v1/staff/summary-pdf").expect(400);
    await admin.post("/api/v1/staff/receipt-image").expect(400);
  });
  it("expands a college year count without duplicates or deleting existing years", async () => {
    const college = await create("/admin/academics/colleges", {
      name: "Expandable college",
      yearCount: 1,
    });
    const original = await AcademicYear.findOne({ collegeId: college._id });
    const body = { collegeId: college._id, yearCount: 4 };
    await create("/admin/academics/academic_years", body);
    await create("/admin/academics/academic_years", body);
    let years = await AcademicYear.find({ collegeId: college._id }).sort({
      order: 1,
    });
    expect(years.map((year) => year.name)).toEqual(["1", "2", "3", "4"]);
    expect(String(years[0]!._id)).toBe(String(original!._id));
    await create("/admin/academics/academic_years", { ...body, yearCount: 5 });
    await create("/admin/academics/academic_years", { ...body, yearCount: 3 });
    years = await AcademicYear.find({ collegeId: college._id });
    expect(years).toHaveLength(5);
  });
  it("saves a package with selected term subjects atomically", async () => {
    const college = await create("/admin/academics/colleges", {
      name: "Package selection college",
      yearCount: 1,
    });
    const year = await AcademicYear.findOne({ collegeId: college._id });
    const term = await create("/admin/academics/terms", {
      name: "1",
      academicYearId: String(year!._id),
    });
    const context = {
      collegeId: college._id,
      academicYearId: String(year!._id),
      termId: term._id,
    };
    const first = await create("/admin/academics/subjects", {
      ...context,
      name: "First subject",
    });
    const second = await create("/admin/academics/subjects", {
      ...context,
      name: "Second subject",
    });
    const body = {
      ...context,
      name: "Selected package",
      isFree: true,
      price: 0,
      subjectIds: [first._id, second._id],
    };
    const pkg = await create("/admin/packages", body);
    expect(
      await PackageSubject.countDocuments({
        packageId: pkg._id,
        status: "active",
      }),
    ).toBe(2);
    const otherTerm = await create("/admin/academics/terms", {
      name: "2",
      academicYearId: String(year!._id),
    });
    const count = await Package.countDocuments();
    await admin
      .post("/api/v1/admin/packages")
      .send({ ...body, termId: otherTerm._id })
      .expect(400);
    expect(await Package.countDocuments()).toBe(count);
    await admin
      .put(`/api/v1/admin/packages/${pkg._id}`)
      .send({ ...body, subjectIds: [first._id] })
      .expect(200);
    expect(
      await PackageSubject.countDocuments({
        packageId: pkg._id,
        status: "active",
      }),
    ).toBe(1);
    expect(
      await PackageSubject.countDocuments({
        packageId: pkg._id,
        status: "archived",
      }),
    ).toBe(1);
  });
  it("rejects a subject attached to a term from another year", async () => {
    const otherYear = await create("/admin/academics/academic_years", {
      name: "2",
      collegeId,
    });
    await admin
      .post("/api/v1/admin/academics/subjects")
      .send({
        name: "Wrong term",
        collegeId,
        academicYearId: otherYear._id,
        termId,
      })
      .expect(400);
  });
  it("allows registration without an active term and rejects mismatched placement", async () => {
    const college = await create("/admin/academics/colleges", {
      name: "Inactive term registration",
    });
    const year = await create("/admin/academics/academic_years", {
      name: "Year 1",
      collegeId: college._id,
    });
    const otherCollege = await create("/admin/academics/colleges", {
      name: "Other registration college",
    });
    const data = {
      fullName: "Waiting student",
      email: "waiting@test.local",
      password,
      confirmPassword: password,
      phone: "+201234567891",
      collegeId: college._id,
      academicYearId: year._id,
    };
    expect(
      await Term.countDocuments({ academicYearId: year._id, status: "active" }),
    ).toBe(0);
    await request(app)
      .post("/api/v1/auth/register")
      .send({ ...data, collegeId: otherCollege._id })
      .expect(400);
    await request(app).post("/api/v1/auth/register").send(data).expect(200);
    const login = await request(app)
      .post("/api/v1/auth/login")
      .send({ email: data.email, password })
      .expect(200);
    expect(login.body.data.user.academicYearId).toBe(String(year._id));
    expect(login.body.data.activeTerm).toBeNull();
    expect(
      await Term.countDocuments({ academicYearId: year._id, status: "active" }),
    ).toBe(0);
  });
  it("registers students immediately, hashes passwords and resolves placement", async () => {
    await student
      .post("/api/v1/auth/register")
      .send({
        fullName: "Student",
        email: "student@test.local",
        password,
        confirmPassword: password,
        phone: "+201234567890",
        collegeId,
        academicYearId: yearId,
      })
      .expect(200);
    const response = await student
      .post("/api/v1/auth/login")
      .send({ email: "student@test.local", password })
      .expect(200);
    studentId = response.body.data.user._id;
    expect(response.body.data.user.passwordHash).toBeUndefined();
    expect(response.body.data.activeTerm._id).toBe(termId);
    const user = await User.findById(studentId).select("+passwordHash");
    expect(user?.passwordHash).not.toBe(password);
  });
  it("denies bad credentials and student admin/finance access", async () => {
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "student@test.local", password: "wrong" })
      .expect(401);
    await student.get("/api/v1/admin/academics").expect(403);
    await student.get("/api/v1/staff/finance").expect(403);
    await request(app).get("/api/v1/auth/me").expect(401);
  });
  it("enforces one student browser even after logout", async () => {
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "student@test.local", password })
      .expect(409);
    const devices = await admin.get("/api/v1/admin/audit/other-devices").expect(200);
    expect(devices.body.data.some((row: { action: string; actor: { _id: string } }) => row.action === "auth.other_device_blocked" && row.actor?._id === studentId)).toBe(true);
    await student.get("/api/v1/admin/audit/other-devices").expect(403);
    await student.post("/api/v1/auth/logout").expect(200);
    await student.get("/api/v1/auth/me").expect(401);
    await student
      .post("/api/v1/auth/login")
      .send({ email: "student@test.local", password })
      .expect(200);
    expect(await StudentDevice.countDocuments({ studentId })).toBe(1);
  });
  it("counts more than ten successful logins today and excludes previous days", async () => {
    const [ten, eleven] = await User.create([
      { fullName: "Ten Logins", email: "ten@test.local", passwordHash: "unused", role: "lecturer", phone: "" },
      { fullName: "Eleven Logins", email: "eleven@test.local", passwordHash: "unused", role: "lecturer", phone: "" },
    ]);
    try {
      await AuditLog.create([
        ...Array.from({ length: 10 }, () => ({ actor: ten!._id, action: "auth.login", entityType: "users", entityId: String(ten!._id) })),
        ...Array.from({ length: 11 }, () => ({ actor: eleven!._id, action: "auth.login", entityType: "users", entityId: String(eleven!._id) })),
        { actor: ten!._id, action: "auth.login", entityType: "users", entityId: String(ten!._id), timestamp: new Date(Date.now() - 48 * 3600000) },
      ]);
      const result = await admin.get("/api/v1/admin/audit/frequent-logins").expect(200);
      expect(result.body.data.find((row: { _id: string }) => row._id === String(eleven!._id))?.count).toBe(11);
      expect(result.body.data.find((row: { _id: string }) => row._id === String(ten!._id))).toBeUndefined();
      await student.get("/api/v1/admin/audit/frequent-logins").expect(403);
    } finally {
      await AuditLog.deleteMany({ actor: { $in: [ten!._id, eleven!._id] } });
      await User.deleteMany({ _id: { $in: [ten!._id, eleven!._id] } });
    }
  });
  it("audits a staff login from a different browser but not a repeat on the same browser", async () => {
    const otherBrowser = request.agent(app);
    const before = await AuditLog.countDocuments({ action: "auth.other_device" });
    await otherBrowser.post("/api/v1/auth/login").send({ email: "admin@test.local", password }).expect(200);
    expect(await AuditLog.countDocuments({ action: "auth.other_device" })).toBe(before + 1);
    await otherBrowser.post("/api/v1/auth/login").send({ email: "admin@test.local", password }).expect(200);
    expect(await AuditLog.countDocuments({ action: "auth.other_device" })).toBe(before + 1);
  });
  it("creates reusable subjects and isolated multi-subject packages", async () => {
    const s1 = await create("/admin/academics/subjects", {
      name: "Algorithms",
      collegeId,
      academicYearId: yearId,
      termId,
    });
    const s2 = await create("/admin/academics/subjects", {
      name: "Databases",
      collegeId,
      academicYearId: yearId,
      termId,
    });
    const base = {
      description: "Course package",
      collegeId,
      academicYearId: yearId,
      termId,
      status: "active",
    };
    freeId = (
      await create("/admin/packages", {
        ...base,
        name: "Free term",
        price: 0,
        isFree: true,
      })
    )._id;
    paidId = (
      await create("/admin/packages", {
        ...base,
        name: "Paid term",
        price: 50000,
        isFree: false,
      })
    )._id;
    psId = (
      await create(`/admin/packages/${freeId}/subjects`, { subjectId: s1._id })
    )._id;
    await create(`/admin/packages/${freeId}/subjects`, {
      subjectId: s2._id,
      order: 1,
    });
    const isolated = await create(`/admin/packages/${paidId}/subjects`, {
      subjectId: s1._id,
    });
    expect(isolated._id).not.toBe(psId);
    expect(await PackageSubject.countDocuments({ packageId: freeId })).toBe(2);
  });
  it("rejects mismatched academic parents", async () => {
    const other = await College.create({ name: "Other", code: "other" });
    await admin
      .post("/api/v1/admin/packages")
      .send({
        name: "Bad",
        collegeId: String(other._id),
        academicYearId: yearId,
        termId,
        price: 0,
        isFree: true,
      })
      .expect(400);
    const response = await admin.post("/api/v1/admin/academics/subjects").send({
      name: "Invalid",
      collegeId: String(other._id),
      academicYearId: yearId,
      termId,
    });
    expect(response.status).toBe(400);
  });
  it("does not automatically grant free access, then claims idempotently", async () => {
    expect(await PackageAccess.countDocuments({ studentId })).toBe(0);
    const response = await student
      .get("/api/v1/student/packages?mode=explore")
      .expect(200);
    expect(response.body.data.map((p: { _id: string }) => p._id)).toContain(
      freeId,
    );
    await student.post(`/api/v1/student/packages/${freeId}/claim`).expect(200);
    await student.post(`/api/v1/student/packages/${freeId}/claim`).expect(200);
    expect(
      await PackageAccess.countDocuments({
        studentId,
        packageId: freeId,
        status: "active",
      }),
    ).toBe(1);
    const explore = await student.get("/api/v1/student/packages?mode=explore");
    expect(explore.body.data.map((p: { _id: string }) => p._id)).not.toContain(
      freeId,
    );
  });
  it("filters Explore by active college, year and term", async () => {
    const alternate = await Term.findOne({
      academicYearId: yearId,
      status: "inactive",
    });
    const hidden = await create("/admin/packages", {
      name: "Hidden",
      collegeId,
      academicYearId: yearId,
      termId: String(alternate!._id),
      price: 0,
      isFree: true,
      status: "active",
    });
    const response = await student.get("/api/v1/student/packages?mode=explore");
    expect(
      response.body.data.some((p: { _id: string }) => p._id === hidden._id),
    ).toBe(false);
    await student
      .post(`/api/v1/student/packages/${hidden._id}/claim`)
      .expect(403);
  });
  it("creates staff and gives conservative explicit scope permissions", async () => {
    lecturerId = (
      await create("/admin/users", {
        fullName: "Lecturer",
        email: "lecturer@test.local",
        password,
        role: "lecturer",
      })
    )._id;
    managerId = (
      await create("/admin/users", {
        fullName: "Manager",
        email: "manager@test.local",
        password,
        role: "content_manager",
      })
    )._id;
    await lecturer
      .post("/api/v1/auth/login")
      .send({ email: "lecturer@test.local", password })
      .expect(200);
    await manager
      .post("/api/v1/auth/login")
      .send({ email: "manager@test.local", password })
      .expect(200);
    await create("/admin/assignments", {
      userId: lecturerId,
      scopeType: "package_subject",
      packageId: freeId,
      packageSubjectId: psId,
      permissions: ["content:view"],
    });
    await create("/admin/assignments", {
      userId: managerId,
      scopeType: "package",
      packageId: freeId,
      permissions: ["content:view", "content:create", "content:edit"],
    });
    await lecturer
      .post("/api/v1/staff/lectures")
      .send({ packageSubjectId: psId, title: "Denied" })
      .expect(403);
    await manager
      .post("/api/v1/staff/lectures")
      .send({
        packageSubjectId: psId,
        title: "Cannot publish",
        status: "published",
      })
      .expect(403);
  });
  it("content manager can view an assigned package before subjects are added", async () => {
    const pkg = await create("/admin/packages", {
      name: "Empty assigned",
      collegeId,
      academicYearId: yearId,
      termId,
      price: 0,
      isFree: true,
      status: "draft",
    });
    await create("/admin/assignments", {
      userId: managerId,
      scopeType: "package",
      packageId: pkg._id,
      permissions: ["content:view"],
    });
    const response = await manager.get("/api/v1/staff/packages");
    expect(
      response.body.data.some((p: { _id: string }) => p._id === pkg._id),
    ).toBe(true);
    await manager.get(`/api/v1/staff/packages/${pkg._id}`).expect(200);
    await lecturer.get(`/api/v1/staff/packages/${pkg._id}`).expect(403);
  });
  it("keeps drafts hidden and publishes accessible lectures only", async () => {
    const response = await manager
      .post("/api/v1/staff/lectures")
      .send({
        packageSubjectId: psId,
        title: "First lecture",
        description: "Learn",
        status: "draft",
      })
      .expect(200);
    lectureId = response.body.data._id;
    await student.get(`/api/v1/student/lectures/${lectureId}`).expect(404);
    await lecturer.get(`/api/v1/staff/lectures/${lectureId}`).expect(200);
    await admin
      .put(`/api/v1/staff/lectures/${lectureId}`)
      .send({
        packageSubjectId: psId,
        title: "First lecture",
        status: "published",
      })
      .expect(200);
    const published = await student
      .get(`/api/v1/student/lectures/${lectureId}`)
      .expect(200);
    expect(published.body.data.lecture.publishedAt).toBeTruthy();
  });
  it("validates materials and prevents editors changing published content without publish permission", async () => {
    await manager
      .post("/api/v1/staff/materials")
      .send({ lectureId, title: "Notes", type: "text", body: "Example" })
      .expect(403);
    await admin
      .post("/api/v1/staff/materials")
      .send({ lectureId, title: "Notes", type: "text" })
      .expect(400);
    await create("/staff/materials", {
      lectureId,
      title: "Notes",
      type: "text",
      body: "Example",
    });
    expect(await Material.countDocuments({ lectureId })).toBe(1);
  });
  it("completes lectures once and derives published-lecture progress", async () => {
    await student
      .post(`/api/v1/student/lectures/${lectureId}/complete`)
      .expect(200);
    await student
      .post(`/api/v1/student/lectures/${lectureId}/complete`)
      .expect(200);
    const response = await student.get(
      "/api/v1/student/packages?mode=learning",
    );
    const pkg = response.body.data.find(
      (p: { _id: string }) => p._id === freeId,
    );
    expect(pkg.progress).toEqual({ completed: 1, total: 1 });
  });
  it("uses publication dates for timeline and excludes inaccessible lectures", async () => {
    await Lecture.updateOne(
      { _id: lectureId },
      { $set: { createdAt: new Date("2000-01-01") } },
    );
    const from = new Date(Date.now() - 86400000).toISOString(),
      to = new Date(Date.now() + 86400000).toISOString();
    const response = await student
      .get(`/api/v1/student/timeline?from=${from}&to=${to}`)
      .expect(200);
    expect(response.body.data.map((l: { _id: string }) => l._id)).toContain(
      lectureId,
    );
  });
  it("scheduled publication becomes published at scheduledAt", async () => {
    const date = new Date(Date.now() - 60000).toISOString();
    const scheduled = await create("/staff/lectures", {
      packageSubjectId: psId,
      title: "Scheduled",
      status: "scheduled",
      scheduledAt: date,
    });
    await publishScheduled();
    const row = await Lecture.findById(scheduled._id);
    expect(row?.status).toBe("published");
    expect(row?.publishedAt.toISOString()).toBe(date);
  });
  it("lecturer student report contains only active access in assigned subjects", async () => {
    const response = await lecturer.get("/api/v1/staff/students").expect(200);
    expect(response.body.data).toHaveLength(1);
    expect(response.body.data[0].student._id).toBe(studentId);
    expect(response.body.data[0].packageSubjectId).toBe(psId);
    expect(response.body.data[0].completed).toBe(1);
    await lecturer
      .post(`/api/v1/admin/students/${studentId}/access`)
      .send({ packageId: paidId })
      .expect(403);
  });
  it("handles pending paid orders with snapshot and atomic completion/access/audit", async () => {
    const prior = env.WHATSAPP_NUMBER;
    delete env.WHATSAPP_NUMBER;
    try {
      const response = await student
        .post(`/api/v1/student/packages/${paidId}/buy`)
        .expect(200);
      orderId = response.body.data.order._id;
      expect(response.body.data.whatsappUrl).toBeUndefined();
      expect(response.body.data.order.status).toBe("pending");
      expect(await PackageAccess.exists({ studentId, packageId: paidId, status: "active" })).toBeNull();
      await student.post(`/api/v1/student/packages/${paidId}/buy`).expect(200);
      expect(
        await Order.countDocuments({
          studentId,
          packageId: paidId,
          status: "pending",
        }),
      ).toBe(1);
      await admin.post(`/api/v1/admin/orders/${orderId}/complete`).expect(200);
      await admin.post(`/api/v1/admin/orders/${orderId}/complete`).expect(200);
      expect(
        await PackageAccess.countDocuments({
          studentId,
          packageId: paidId,
          status: "active",
        }),
      ).toBe(1);
      expect(
        await AuditLog.countDocuments({
          action: "order.completed",
          entityId: orderId,
        }),
      ).toBe(1);
      expect((await Order.findById(orderId))?.priceSnapshot).toBe(50000);
    } finally {
      if (prior) env.WHATSAPP_NUMBER = prior;
      else delete env.WHATSAPP_NUMBER;
    }
  });
  it("restricts expenses to owner and derives admin profit from completed orders", async () => {
    const expense = await manager
      .post("/api/v1/staff/expenses")
      .send({
        category: "hosting",
        amount: 1000,
        date: new Date().toISOString(),
      })
      .expect(200);
    expenseId = expense.body.data._id;
    const own = await manager.get("/api/v1/staff/finance");
    expect(own.body.data.revenue).toBeUndefined();
    expect(own.body.data.expenses).toHaveLength(1);
    const other = await lecturer.get("/api/v1/staff/finance");
    expect(other.body.data.expenses).toHaveLength(0);
    await lecturer
      .put(`/api/v1/staff/expenses/${expenseId}`)
      .send({ category: "hosting", amount: 1, date: new Date().toISOString() })
      .expect(403);
    const all = await admin.get("/api/v1/staff/finance");
    expect(all.body.data.revenue).toBe(50000);
    expect(all.body.data.netProfit).toBe(49000);
  });
  it("revocation removes content and lecturer visibility without deleting history", async () => {
    await admin
      .post(`/api/v1/admin/students/${studentId}/access`)
      .send({ packageId: freeId, revoke: true })
      .expect(200);
    await student.get(`/api/v1/student/lectures/${lectureId}`).expect(403);
    const report = await lecturer.get("/api/v1/staff/students");
    expect(report.body.data).toHaveLength(0);
    expect(await AuditLog.countDocuments({ action: "access.revoked" })).toBe(1);
  });
  it("device reset invalidates sessions and allows a different browser", async () => {
    await admin
      .post(`/api/v1/admin/students/${studentId}/reset-device`)
      .expect(200);
    await student.get("/api/v1/auth/me").expect(401);
    expect(await Session.countDocuments({ userId: studentId })).toBe(0);
    await request(app)
      .post("/api/v1/auth/login")
      .send({ email: "student@test.local", password })
      .expect(200);
  });
  it("disabled accounts immediately lose session access", async () => {
    await admin
      .patch(`/api/v1/admin/users/${managerId}`)
      .send({ status: "disabled" })
      .expect(200);
    await manager.get("/api/v1/staff/finance").expect(401);
  });
  it("does not expose hashes and provides immutable audit APIs", async () => {
    const response = await admin.get("/api/v1/admin/users?role=student");
    expect(JSON.stringify(response.body)).not.toContain("passwordHash");
    await admin.delete("/api/v1/admin/audit").expect(404);
    expect(await AuditLog.countDocuments()).toBeGreaterThan(15);
  });
  it("change-password invalidates every session and rejects the old password", async () => {
    await lecturer
      .post("/api/v1/auth/change-password")
      .send({
        currentPassword: "wrong",
        password: "New-test-password!",
        confirmPassword: "New-test-password!",
      })
      .expect(400);
    await lecturer
      .post("/api/v1/auth/change-password")
      .send({
        currentPassword: password,
        password: "New-test-password!",
        confirmPassword: "New-test-password!",
      })
      .expect(200);
    await lecturer.get("/api/v1/auth/me").expect(401);
    await lecturer
      .post("/api/v1/auth/login")
      .send({ email: "lecturer@test.local", password })
      .expect(401);
    await lecturer
      .post("/api/v1/auth/login")
      .send({ email: "lecturer@test.local", password: "New-test-password!" })
      .expect(200);
  });
  it("cancelling an order grants no access and generates no revenue", async () => {
    const order = await Order.create({
      studentId,
      packageId: paidId,
      priceSnapshot: 999,
      status: "pending",
    });
    await admin.post(`/api/v1/admin/orders/${order._id}/cancel`).expect(200);
    expect((await Order.findById(order._id))?.status).toBe("cancelled");
    await admin.post(`/api/v1/admin/orders/${order._id}/complete`).expect(409);
    const accounts = await admin.get("/api/v1/staff/finance");
    expect(accounts.body.data.revenue).toBe(50000);
  });
  it("preserves previously published lectures and history when returned to draft", async () => {
    await admin
      .put(`/api/v1/staff/lectures/${lectureId}`)
      .send({ packageSubjectId: psId, title: "First lecture", status: "draft" })
      .expect(200);
    await admin.delete(`/api/v1/staff/lectures/${lectureId}`).expect(409);
    expect(await Lecture.exists({ _id: lectureId })).toBeTruthy();
  });
  it("database model validation rejects missing student placement and material content", async () => {
    await expect(
      User.create({
        fullName: "Invalid",
        email: "invalid@test.local",
        role: "student",
        passwordHash: "hash",
      }),
    ).rejects.toThrow();
    await expect(
      Material.create({ lectureId, title: "Invalid", type: "text" }),
    ).rejects.toThrow();
  });
  it("idempotently seeds a normally hashed test administrator", async () => {
    process.env.INITIAL_ADMIN_PASSWORD = password;
    const first = await seedAdmin(),
      second = await seedAdmin();
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    const user = await User.findOne({ email: "kamel@endpoint.local" }).select(
      "+passwordHash",
    );
    expect(await bcrypt.compare(password, user!.passwordHash)).toBe(true);
    delete process.env.INITIAL_ADMIN_PASSWORD;
  });
});
