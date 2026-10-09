import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { env } from "./config/env.js";
import { router } from "./modules/api/routes.js";
import { errors } from "./shared/http.js";
export const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(cors({ origin: env.FRONTEND_URL, credentials: true }));
app.use(express.json({ limit: "3mb" }));
app.use(cookieParser(env.COOKIE_SECRET));
app.use((req, res, next) => {
  if (
    !["GET", "HEAD", "OPTIONS"].includes(req.method) &&
    req.get("origin") &&
    req.get("origin") !== env.FRONTEND_URL
  ) {
    res.status(403).json({ error: { code: "ORIGIN_DENIED" } });
    return;
  }
  next();
});
const attempts = new Map<string, { count: number; until: number }>();
app.use("/api/v1/auth", (req, res, next) => {
  if (!["/login", "/register"].includes(req.path) || req.method !== "POST") {
    next();
    return;
  }
  const key = req.ip || "unknown";
  const now = Date.now();
  if (attempts.size > 10000)
    for (const [k, v] of attempts) if (v.until < now) attempts.delete(k);
  const item = attempts.get(key);
  if (item && item.until > now && item.count >= 30) {
    res.status(429).json({ error: { code: "RATE_LIMIT" } });
    return;
  }
  attempts.set(
    key,
    item && item.until > now
      ? { ...item, count: item.count + 1 }
      : { count: 1, until: now + 15 * 60000 },
  );
  next();
});
app.use("/api/v1", router);
app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND" } }));
app.use(errors);
