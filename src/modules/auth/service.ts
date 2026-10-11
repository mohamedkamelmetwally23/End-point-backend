import { dto } from "../../shared/dto.js";
import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { User, Session, StudentDevice, AuditLog, College, AcademicYear } from "../domain/models.js";
import { id } from "../domain/validation.js";
import { activeTerm, placement } from "../academics/service.js";
import { ensure, ApiError } from "../../shared/errors.js";
import { transaction } from "../../shared/database.js";
import { audit } from "../audit/service.js";
export const hash = (v: string) =>
  crypto.createHash("sha256").update(v).digest("hex");
const random = () => crypto.randomBytes(48).toString("base64url");
const cookieOptions = {
  httpOnly: true,
  secure: env.NODE_ENV === "production",
  sameSite: env.COOKIE_SAME_SITE,
  signed: true,
  path: "/",
};
export const registerSchema = z
  .object({
    fullName: z.string().trim().min(2).max(160),
    email: z.email().toLowerCase(),
    password: z.string().min(12).max(128),
    confirmPassword: z.string(),
    phone: z.string().regex(/^\+?[\d\s()-]{8,25}$/),
    collegeId: id,
    academicYearId: id,
  })
  .refine((v) => v.password === v.confirmPassword, "Passwords differ");
const loginSchema = z.object({
  email: z.email().toLowerCase(),
  password: z.string().min(1).max(128),
});
export async function register(body: unknown) {
  const data = registerSchema.parse(body);
  await placement(data.collegeId, data.academicYearId);
  const { password, confirmPassword: _confirm, ...fields } = data;
  return transaction(async (session) => {
    const user = (
      await User.create(
        [
          {
            ...fields,
            role: "student",
            passwordHash: await bcrypt.hash(password, 12),
          },
        ],
        { session },
      )
    )[0]!;
    await audit(user._id, "user.created", "users", user._id, {}, session);
    return user;
  });
}
export async function login(req: Request, res: Response) {
  const { email, password } = loginSchema.parse(req.body);
  const user = await User.findOne({ email }).select("+passwordHash");
  ensure(
    user && (await bcrypt.compare(password, String(user.passwordHash))),
    401,
    "INVALID_CREDENTIALS",
  );
  ensure(user.status === "active", 403, "ACCOUNT_DISABLED");
  const deviceToken =
    typeof req.signedCookies.device === "string"
      ? req.signedCookies.device
      : random();
  const sessionToken = random();
  const deviceId = hash(deviceToken);
  const registeredDevice = user.role === "student"
    ? await StudentDevice.findOne({ studentId: user._id }).select("+tokenHash")
    : null;
  if (registeredDevice && registeredDevice.tokenHash !== deviceId) {
    await audit(user._id, "auth.other_device_blocked", "users", user._id, { ip: req.ip, userAgent: req.get("user-agent") || "" });
    ensure(false, 409, "DEVICE_LIMIT");
  }
  const previousLogin = await AuditLog.findOne({ actor: user._id, action: "auth.login", "metadata.deviceId": { $exists: true } }).sort({ timestamp: -1 }).select("metadata").lean();
  await transaction(async (session) => {
    if (user.role === "student") {
      const device = await StudentDevice.findOne({ studentId: user._id })
        .select("+tokenHash")
        .session(session);
      if (device)
        ensure(device.tokenHash === hash(deviceToken), 409, "DEVICE_LIMIT");
      else
        await StudentDevice.create(
          [
            {
              studentId: user._id,
              tokenHash: hash(deviceToken),
              userAgentHash: hash(req.get("user-agent") || ""),
              registeredAt: new Date(),
            },
          ],
          { session },
        );
    }
    await Session.create(
      [
        {
          userId: user._id,
          tokenHash: hash(sessionToken),
          expiresAt: new Date(Date.now() + 7 * 86400000),
        },
      ],
      { session },
    );
    const metadata = { deviceId, ip: req.ip, userAgent: req.get("user-agent") || "" };
    if (previousLogin?.metadata?.deviceId && previousLogin.metadata.deviceId !== deviceId)
      await audit(user._id, "auth.other_device", "users", user._id, { ip: metadata.ip, userAgent: metadata.userAgent }, session);
    await audit(user._id, "auth.login", "users", user._id, metadata, session);
  });
  res.cookie("device", deviceToken, {
    ...cookieOptions,
    maxAge: 400 * 86400000,
  });
  res.cookie("session", sessionToken, {
    ...cookieOptions,
    maxAge: 7 * 86400000,
  });
  return bootstrap(user._id);
}
export async function logout(req: Request, res: Response) {
  if (typeof req.signedCookies.session === "string")
    await Session.deleteOne({ tokenHash: hash(req.signedCookies.session) });
  res.clearCookie("session", cookieOptions);
}
export async function profile(userId: unknown) {
  const projection = "_id fullName email phone role collegeId academicYearId";
  const user = await User.findById(userId).select(projection).lean();
  ensure(user, 401, "PROFILE_USER_MISSING");
  if (user.role !== "student") return { user: dto(user, projection) };
  const [college, academicYear, term, device] = await Promise.all([
    College.findById(user.collegeId).select("_id name").lean(),
    AcademicYear.findOne({ _id: user.academicYearId, collegeId: user.collegeId }).select("_id name order").lean(),
    activeTerm(user.collegeId, user.academicYearId).catch(error => {
      if (error instanceof ApiError && error.code === "NO_ACTIVE_TERM") return null;
      throw error;
    }),
    StudentDevice.findOne({ studentId: userId }).select("registeredAt -_id").lean(),
  ]);
  ensure(college && academicYear, 400, "INVALID_ACADEMIC_CONTEXT");
  return {
    user: dto(user, projection),
    college: dto(college, "_id name"),
    academicYear: dto(academicYear, "_id name order"),
    activeTerm: dto(term, "_id name order localOrder"),
    device: dto(device, "registeredAt"),
  };
}
export async function changePassword(userId: unknown, body: unknown) {
  const data = z
    .object({
      currentPassword: z.string(),
      password: z.string().min(12).max(128),
      confirmPassword: z.string(),
    })
    .refine((v) => v.password === v.confirmPassword)
    .parse(body);
  const user = await User.findById(userId).select("+passwordHash");
  ensure(
    user &&
      (await bcrypt.compare(data.currentPassword, String(user.passwordHash))),
    400,
    "INVALID_CREDENTIALS",
  );
  await transaction(async (session) => {
    user.passwordHash = await bcrypt.hash(data.password, 12);
    await user.save({ session });
    await Session.deleteMany({ userId }).session(session);
    await audit(userId, "auth.password_changed", "users", userId, {}, session);
  });
}

export async function bootstrap(userId: unknown) {
  const user = await User.findById(userId).select("_id fullName role").lean();
  ensure(user, 401, "UNAUTHENTICATED");
  return { user: dto(user, "_id fullName role") };
}

export async function updateProfile(userId: string, body: unknown) {
  const data = z.object({
    fullName: z.string().trim().min(2).max(160),
    phone: z.union([z.literal(""), z.string().regex(/^\+?[\d\s()-]{8,25}$/)]).optional(),
  }).strict().parse(body);
  return transaction(async session => {
    const user = await User.findByIdAndUpdate(userId, { $set: data }, { new: true, runValidators: true, session });
    ensure(user, 401, "PROFILE_USER_MISSING");
    await audit(userId, "profile.updated", "users", userId, {}, session);
    return dto(user, "_id fullName phone");
  });
}
