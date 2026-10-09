import type { Request, Response, NextFunction } from "express";
import { Session, User, StudentDevice } from "../modules/domain/models.js";
import { hash } from "../modules/auth/service.js";
import { ensure } from "../shared/errors.js";
declare global {
  namespace Express {
    interface Request {
      principal: {
        userId: string;
        role: string;
        collegeId?: string;
        academicYearId?: string;
      };
    }
  }
}
export async function authenticate(
  req: Request,
  _res: Response,
  next: NextFunction,
) {
  try {
    const token = req.signedCookies.session;
    ensure(typeof token === "string", 401, "UNAUTHENTICATED");
    const session = await Session.findOne({
      tokenHash: hash(token),
      expiresAt: { $gt: new Date() },
    });
    ensure(session, 401, "UNAUTHENTICATED");
    const user = await User.findOne({ _id: session.userId, status: "active" });
    ensure(user, 401, "UNAUTHENTICATED");
    if (user.role === "student") {
      const device = req.signedCookies.device;
      ensure(
        typeof device === "string" &&
          (await StudentDevice.exists({
            studentId: user._id,
            tokenHash: hash(device),
          })),
        401,
        "DEVICE_RESET",
      );
    }
    req.principal = {
      userId: String(user._id),
      role: String(user.role),
      ...(user.collegeId
        ? {
            collegeId: String(user.collegeId),
            academicYearId: String(user.academicYearId),
          }
        : {}),
    };
    next();
  } catch (error) {
    next(error);
  }
}
export const authorize =
  (...roles: string[]) =>
  (req: Request, _res: Response, next: NextFunction) => {
    try {
      ensure(roles.includes(req.principal.role), 403, "FORBIDDEN");
      next();
    } catch (e) {
      next(e);
    }
  };
