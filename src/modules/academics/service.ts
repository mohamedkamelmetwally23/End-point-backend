import { AcademicYear, College, Term, models } from "../domain/models.js";
import {
  academicSchemas,
  academicYearsCountSchema,
  id,
} from "../domain/validation.js";
import { ensure } from "../../shared/errors.js";
import { transaction } from "../../shared/database.js";
import { audit } from "../audit/service.js";
import type { ClientSession } from "mongoose";

export async function ensureYearTerms(
  academicYearId: unknown,
  session?: ClientSession,
) {
  const defaults = [
    {
      name: "الترم الأول",
      aliases: [
        "الترم الأول",
        "الترم الاول",
        "الترم أول",
        "الترم اول",
        "ترم أول",
        "ترم اول",
        "Term 1",
        "First term",
      ],
    },
    {
      name: "الترم الثاني",
      aliases: [
        "الترم الثاني",
        "الترم الثانى",
        "الترم التاني",
        "الترم التانى",
        "ترم ثاني",
        "ترم تاني",
        "Term 2",
        "Second term",
      ],
    },
  ];
  // A year with two explicitly seeded semesters already has its term structure.
  if (
    (await Term.countDocuments({ academicYearId }).session(session ?? null)) >=
    2
  )
    return;
  for (const term of defaults) {
    await Term.findOneAndUpdate(
      { academicYearId, name: { $in: term.aliases } },
      { $setOnInsert: { academicYearId, name: term.name, status: "inactive" } },
      { upsert: true, runValidators: true, ...(session ? { session } : {}) },
    );
  }
}

export async function ensureAllYearTerms() {
  const years = await AcademicYear.find().select("_id").lean();
  for (const year of years) await ensureYearTerms(year._id);
  return years.length;
}
export async function placement(collegeId: unknown, academicYearId: unknown) {
  const [college, year] = await Promise.all([
    College.findOne({ _id: collegeId, status: "active" }),
    AcademicYear.findOne({ _id: academicYearId, collegeId, status: "active" }),
  ]);
  ensure(college && year, 400, "INVALID_ACADEMIC_CONTEXT");
  return { college, year };
}
export async function activeTerm(collegeId: unknown, academicYearId: unknown) {
  await placement(collegeId, academicYearId);
  const term = await Term.findOne({ academicYearId, status: "active" });
  ensure(term, 409, "NO_ACTIVE_TERM");
  return term;
}
export async function academics(publicOnly = false) {
  const filter = publicOnly ? { status: "active" } : {};
  const [colleges, academic_years, terms, subjects] = await Promise.all([
    College.find(filter).lean(),
    AcademicYear.find(filter).sort({ order: 1 }).lean(),
    Term.find(publicOnly ? { status: "active" } : {})
      .sort({ order: 1 })
      .lean(),
    models.subjects.find(filter).lean(),
  ]);
  return { colleges, academic_years, terms, subjects };
}
export async function saveAcademic(
  actor: unknown,
  kind: string,
  body: unknown,
  entityId?: string,
) {
  ensure(kind in academicSchemas, 404, "NOT_FOUND");
  if (
    kind === "academic_years" &&
    typeof body === "object" &&
    body !== null &&
    "yearCount" in body
  ) {
    const data = academicYearsCountSchema.parse(body);
    ensure(
      await College.exists({ _id: data.collegeId, status: "active" }),
      400,
      "INVALID_COLLEGE",
    );
    return transaction(async (session) => {
      const result = [];
      for (let number = 1; number <= data.yearCount; number++) {
        const name = String(number);
        const existing = await AcademicYear.findOne({
          collegeId: data.collegeId,
          $or: [{ name }, { order: number }],
        }).session(session);
        const record =
          existing ||
          (
            await AcademicYear.create(
              [
                {
                  collegeId: data.collegeId,
                  name,
                  order: number,
                  status: data.status,
                },
              ],
              { session },
            )
          )[0]!;
        result.push(record);
        await ensureYearTerms(record._id, session);
        if (!existing)
          await audit(
            actor,
            "academic.created",
            "academic_years",
            record._id,
            {},
            session,
          );
      }
      return result;
    });
  }
  const key = kind as keyof typeof academicSchemas;
  const data = academicSchemas[key].parse(body);
  if ("collegeId" in data)
    ensure(
      await College.exists({ _id: data.collegeId, status: "active" }),
      400,
      "INVALID_COLLEGE",
    );
  if ("academicYearId" in data && data.academicYearId) {
    const year = await AcademicYear.findById(data.academicYearId);
    ensure(year && year.status === "active", 400, "INVALID_YEAR");
    if ("collegeId" in data)
      ensure(
        String(year.collegeId) === data.collegeId,
        400,
        "INVALID_ACADEMIC_CONTEXT",
      );
  }
  if ("termId" in data && "academicYearId" in data) {
    ensure(
      await Term.exists({
        _id: data.termId,
        academicYearId: data.academicYearId,
        status: { $ne: "archived" },
      }),
      400,
      "INVALID_ACADEMIC_CONTEXT",
    );
  }
  return transaction(async (session) => {
    if (entityId) id.parse(entityId);
    const existing = entityId
      ? await models[key].findById(entityId).session(session)
      : null;
    if (entityId) ensure(existing, 404, "NOT_FOUND");
    if (existing) {
      for (const parent of ["collegeId", "academicYearId", "termId"])
        if (parent in data && existing.get(parent) != null)
          ensure(
            String(existing.get(parent)) ===
              String(data[parent as keyof typeof data]),
            409,
            "PARENT_IMMUTABLE",
          );
    }
    if (key === "terms" && data.status === "active" && "academicYearId" in data)
      await Term.updateMany(
        {
          academicYearId: data.academicYearId,
          status: "active",
          ...(entityId ? { _id: { $ne: entityId } } : {}),
        },
        { $set: { status: "inactive" } },
        { session },
      );
    const recordData = Object.fromEntries(
      Object.entries(data).filter(([field]) => field !== "yearCount"),
    );
    const record = existing
      ? await existing.set(recordData).save({ session })
      : (await models[key].create([recordData], { session }))[0]!;
    if (key === "academic_years") await ensureYearTerms(record._id, session);
    if (
      !existing &&
      key === "colleges" &&
      "yearCount" in data &&
      data.yearCount
    ) {
      const years = await AcademicYear.create(
        Array.from({ length: data.yearCount }, (_, index) => ({
          name: String(index + 1),
          order: index + 1,
          collegeId: record._id,
          status: "active",
        })),
        { session, ordered: true },
      );
      for (const year of years) await ensureYearTerms(year._id, session);
    }
    await audit(
      actor,
      existing ? "academic.updated" : "academic.created",
      key,
      record._id,
      {},
      session,
    );
    return record;
  });
}
