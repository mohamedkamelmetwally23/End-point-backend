import { beforeEach, expect, it, vi } from "vitest";
vi.mock("../src/modules/academics/service.js", () => ({ activeTerm: vi.fn(), placement: vi.fn() }));
import { activeTerm } from "../src/modules/academics/service.js";
import { User, College, AcademicYear, StudentDevice } from "../src/modules/domain/models.js";
import { profile, bootstrap, updateProfile } from "../src/modules/auth/service.js";
import { ApiError } from "../src/shared/errors.js";

const user = { _id: "student", fullName: "Student", email: "student@test.local", role: "student", collegeId: "college", academicYearId: "year", passwordHash: "secret", __v: 1 };
const query = (value: unknown) => ({ select: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(value) }) });
beforeEach(() => {
  vi.restoreAllMocks();
  vi.spyOn(User, "findById").mockReturnValue(query(user) as never);
  vi.spyOn(College, "findById").mockReturnValue(query({ _id: "college", name: "College", __v: 1 }) as never);
  vi.spyOn(AcademicYear, "findOne").mockReturnValue(query({ _id: "year", name: "4", order: 4, __v: 1 }) as never);
  vi.spyOn(StudentDevice, "findOne").mockReturnValue(query({ registeredAt: "2026-10-11", tokenHash: "secret" }) as never);
  vi.mocked(activeTerm).mockResolvedValue({ _id: "term", name: "Semester 7", order: 7, localOrder: 1, status: "active", __v: 1 } as never);
});
it("serializes only profile fields and uses the canonical active-term resolver", async () => {
  const result = await profile("student");
  expect(result).toEqual({
    user: { _id: "student", fullName: "Student", email: "student@test.local", role: "student", collegeId: "college", academicYearId: "year" },
    college: { _id: "college", name: "College" }, academicYear: { _id: "year", name: "4", order: 4 },
    activeTerm: { _id: "term", name: "Semester 7", order: 7, localOrder: 1 }, device: { registeredAt: "2026-10-11" },
  });
  expect(activeTerm).toHaveBeenLastCalledWith("college", "year");
  expect(await bootstrap("student")).toEqual({ user: { _id: "student", fullName: "Student", role: "student" } });
});
it("allows no active term but propagates academic and database failures", async () => {
  vi.mocked(activeTerm).mockRejectedValueOnce(new ApiError(409, "NO_ACTIVE_TERM"));
  expect((await profile("student")).activeTerm).toBeNull();
  vi.mocked(activeTerm).mockRejectedValueOnce(new ApiError(400, "INVALID_ACADEMIC_CONTEXT"));
  await expect(profile("student")).rejects.toMatchObject({ code: "INVALID_ACADEMIC_CONTEXT" });
  vi.mocked(activeTerm).mockRejectedValueOnce(new Error("database failed"));
  await expect(profile("student")).rejects.toThrow("database failed");
});
it("reports a missing authenticated user separately", async () => {
  vi.mocked(User.findById).mockReturnValue(query(null) as never);
  await expect(profile("student")).rejects.toMatchObject({ code: "PROFILE_USER_MISSING" });
});
it.each(["role", "collegeId", "academicYearId", "activeTerm", "packageAccess"])("rejects edits to %s before any write", async key => {
  await expect(updateProfile("student", { fullName: "Student", phone: "", [key]: "restricted" })).rejects.toMatchObject({ name: "ZodError" });
});
