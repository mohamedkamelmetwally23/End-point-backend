import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import type { Request, Response } from "express";
import { env } from "../../config/env.js";
import { User, Session, StudentDevice } from "../domain/models.js";
import { id } from "../domain/validation.js";
import { activeTerm, placement } from "../academics/service.js";
import { ensure } from "../../shared/errors.js";
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
    await audit(user._id, "auth.login", "users", user._id, {}, session);
  });
  res.cookie("device", deviceToken, {
    ...cookieOptions,
    maxAge: 400 * 86400000,
  });
  res.cookie("session", sessionToken, {
    ...cookieOptions,
    maxAge: 7 * 86400000,
  });
  return profile(user._id);
}
export async function logout(req: Request, res: Response) {
  if (typeof req.signedCookies.session === "string")
    await Session.deleteOne({ tokenHash: hash(req.signedCookies.session) });
  res.clearCookie("session", cookieOptions);
}
export async function profile(userId: unknown) {
  const user = await User.findById(userId).lean();
  ensure(user, 401, "UNAUTHENTICATED");
  if (user.role !== "student") return { user };
  const term = await activeTerm(user.collegeId, user.academicYearId).catch(
    () => null,
  );
  return {
    user,
    activeTerm: term,
    device: await StudentDevice.findOne({ studentId: userId })
      .select("registeredAt")
      .lean(),
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
