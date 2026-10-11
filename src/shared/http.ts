import { PageResult } from "./pagination.js";
import type { Request, Response, NextFunction, RequestHandler } from "express";
import { ZodError } from "zod";
import { ApiError } from "./errors.js";
export const endpoint =
  (fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler =>
  async (req, res, next) => {
    try {
      const data = await fn(req, res);
      if (!res.headersSent) res.json(data instanceof PageResult ? data : { data: data ?? null });
    } catch (error) {
      next(error);
    }
  };
export function errors(
  error: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
) {
  if (error instanceof ApiError) {
    res
      .status(error.status)
      .json({ error: { code: error.code, message: error.message } });
    return;
  }
  if (error instanceof ZodError) {
    res.status(400).json({
      error: {
        code: "VALIDATION_ERROR",
        fields: error.issues.map((i) => ({
          path: i.path.join("."),
          message: i.message,
        })),
      },
    });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    error.code === 11000
  ) {
    res.status(409).json({ error: { code: "DUPLICATE_RECORD" } });
    return;
  }
  if (
    error &&
    typeof error === "object" &&
    "type" in error &&
    error.type === "entity.parse.failed"
  ) {
    res.status(400).json({ error: { code: "INVALID_JSON" } });
    return;
  }
  if (error && typeof error === "object" && "type" in error && error.type === "entity.too.large") {
    res.status(413).json({ error: { code: "PAYLOAD_TOO_LARGE", message: "Request body exceeds the allowed size" } });
    return;
  }
  console.error(
    "Request failed:",
    error instanceof Error ? error.name : "unknown",
  );
  res.status(500).json({ error: { code: "INTERNAL_ERROR" } });
}
