import { createHash, timingSafeEqual } from "node:crypto";
import type { RequestHandler } from "express";
import { env } from "../../config/env.js";
import { connect } from "../../shared/database.js";
import { publishScheduled } from "./service.js";

const digest = (value: string) => createHash("sha256").update(value).digest();

export const publishDueLectures: RequestHandler = async (req, res) => {
  res.set("Cache-Control", "no-store");
  if (!env.CRON_SECRET || !timingSafeEqual(
    digest(req.get("authorization") ?? ""), digest(`Bearer ${env.CRON_SECRET}`),
  )) {
    res.status(401).json({ error: { code: "UNAUTHORIZED" } });
    return;
  }
  // Express otherwise treats HEAD as GET, which must not trigger maintenance.
  if (req.method !== "GET") {
    res.set("Allow", "GET").status(405).end();
    return;
  }
  const started = Date.now();
  const startedAt = new Date(started).toISOString();
  let counts: { processed: number; published: number } | null = null;
  let errors = 0;
  let connected = false;
  try {
    await connect();
    connected = true;
    counts = await publishScheduled();
    res.json({ data: counts });
  } catch {
    errors = 1;
    res.status(connected ? 500 : 503).json({ error: {
      code: connected ? "PUBLICATION_FAILED" : "DATABASE_UNAVAILABLE",
    } });
  } finally {
    // Null counts on failure: earlier batches may already have committed.
    console.info("scheduled-publication", {
      startedAt, processed: counts?.processed ?? null,
      published: counts?.published ?? null, durationMs: Date.now() - started, errors,
    });
  }
};
