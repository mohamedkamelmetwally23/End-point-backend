import type { Request, Response } from "express";
import { app } from "../src/app.js";
import { connect } from "../src/shared/database.js";

// Vercel owns the HTTP listener. Reuse the same Express routes and middleware.
export default async function handler(req: Request, res: Response) {
  const pathname = (req.url || "/").split("?")[0];
  // Liveness and CORS preflight do not require a database connection.
  if (
    req.method !== "OPTIONS" &&
    pathname !== "/health" &&
    pathname !== "/api/v1/health"
  ) {
    try {
      await connect();
    } catch {
      res.statusCode = 503;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ error: { code: "DATABASE_UNAVAILABLE" } }));
      return;
    }
  }
  app(req, res);
}
