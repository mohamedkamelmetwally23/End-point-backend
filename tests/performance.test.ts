import { afterEach, describe, expect, it, vi } from "vitest";
import { dto, fields } from "../src/shared/dto.js";
import { pageQuery, pageResult } from "../src/shared/pagination.js";
import { Package, PackageSubject, PackageAccess, Lecture, LectureProgress } from "../src/modules/domain/models.js";
import { listPackages } from "../src/modules/packages/service.js";
function read(rows: unknown[]) {
  const query = { select: vi.fn(), sort: vi.fn(), populate: vi.fn(), lean: vi.fn().mockResolvedValue(rows) };
  query.select.mockReturnValue(query); query.sort.mockReturnValue(query); query.populate.mockReturnValue(query);
  return query as never;
}
afterEach(() => vi.restoreAllMocks());
describe("Performance contracts", () => {
  it("allowlists documents even if secret fields were explicitly selected", () => {
    expect(dto({ _id: "u", fullName: "User", role: "student", passwordHash: "secret", __v: 2, updatedAt: new Date() }, fields.user))
      .toEqual({ _id: "u", fullName: "User", role: "student" });
  });
  it("bounds pagination and computes hasNext", () => {
    expect(pageQuery.parse({})).toEqual({ page: 1, limit: 20 });
    for (const query of [{ page: 0 }, { limit: 101 }, { page: 1.5 }]) expect(pageQuery.safeParse(query).success).toBe(false);
    expect(pageResult([], 21, 1, 20).pagination.hasNext).toBe(true);
    expect(pageResult([], 21, 2, 20).pagination.hasNext).toBe(false);
  });
  it("loads progress for fifty packages with two progress reads, preserving totals", async () => {
    const packages = Array.from({ length: 50 }, (_, i) => ({ _id: `p${i}`, name: `Package ${i}` }));
    vi.spyOn(PackageAccess, "find").mockReturnValue(read(packages.map(p => ({ packageId: p._id }))));
    vi.spyOn(Package, "find").mockReturnValue(read(packages));
    vi.spyOn(PackageSubject, "find").mockReturnValue(read(packages.map((p, i) => ({ _id: `s${i}`, packageId: p._id, subjectId: { status: "active" } }))));
    const lectureRead = vi.spyOn(Lecture, "find").mockReturnValue(read(packages.map((_, i) => ({ _id: `l${i}`, packageSubjectId: `s${i}` }))));
    const progressRead = vi.spyOn(LectureProgress, "find").mockReturnValue(read([{ lectureId: "l0" }]));
    const counts = vi.spyOn(LectureProgress, "countDocuments");
    const result = await listPackages({ userId: "student", role: "student" }, "learning");
    expect(result).toHaveLength(50);
    expect(result[0]?.progress).toEqual({ total: 1, completed: 1 });
    expect(result[49]?.progress).toEqual({ total: 1, completed: 0 });
    expect(lectureRead).toHaveBeenCalledTimes(1);
    expect(progressRead).toHaveBeenCalledTimes(1);
    expect(counts).not.toHaveBeenCalled();
  });
});
