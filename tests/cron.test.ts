import { afterEach, beforeEach, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { env } from "../src/config/env.js";
import app from "../src/app.js";
import { connect } from "../src/shared/database.js";
import { publishScheduled } from "../src/modules/content/service.js";

vi.mock("../src/shared/database.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/shared/database.js")>(),
  connect: vi.fn(),
}));
vi.mock("../src/modules/content/service.js", async importOriginal => ({
  ...await importOriginal<typeof import("../src/modules/content/service.js")>(),
  publishScheduled: vi.fn(),
}));
const secret = "synthetic-cron-test-secret-32-characters";
const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const path: string = config.crons[0].path;
const previous = env.CRON_SECRET;
beforeEach(() => {
  env.CRON_SECRET = secret;
  vi.stubEnv("VERCEL", "1");
  vi.mocked(connect).mockReset().mockResolvedValue(undefined as never);
  vi.mocked(publishScheduled).mockReset().mockResolvedValue({ processed: 12, published: 12 });
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => {
  env.CRON_SECRET = previous;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
it("rejects absent, invalid, and unconfigured secrets before database access", async () => {
  await request(app).get(path).expect(401);
  await request(app).get(path).set("Authorization", "Bearer wrong").expect(401);
  env.CRON_SECRET = undefined;
  await request(app).get(path).set("Authorization", `Bearer ${secret}`).expect(401);
  expect(connect).not.toHaveBeenCalled();
  expect(publishScheduled).not.toHaveBeenCalled();
});
it("uses the Vercel app entrypoint, returns only counts, and logs safe metrics", async () => {
  expect(config.framework).toBe("express");
  expect(config.crons).toEqual([{ path: "/api/internal/publish-due-lectures", schedule: "*/5 * * * *" }]);
  const result = await request(app).get(path).set("Authorization", `Bearer ${secret}`)
    .expect("Cache-Control", "no-store").expect(200);
  expect(result.body).toEqual({ data: { processed: 12, published: 12 } });
  expect(Buffer.byteLength(result.text)).toBeLessThan(100);
  expect(connect).toHaveBeenCalledOnce();
  expect(publishScheduled).toHaveBeenCalledOnce();
  expect(console.info).toHaveBeenCalledWith("scheduled-publication", {
    startedAt: expect.any(String), processed: 12, published: 12,
    durationMs: expect.any(Number), errors: 0,
  });
  expect(JSON.stringify(vi.mocked(console.info).mock.calls)).not.toContain(secret);
});
it("does not publish for HEAD or POST", async () => {
  await request(app).head(path).set("Authorization", `Bearer ${secret}`).expect(405);
  await request(app).post(path).set("Authorization", `Bearer ${secret}`).expect(405);
  expect(publishScheduled).not.toHaveBeenCalled();
});
it("returns safe failures and logs unknown counts when publication fails", async () => {
  vi.mocked(publishScheduled).mockRejectedValueOnce(new Error("private lecture details"));
  await request(app).get(path).set("Authorization", `Bearer ${secret}`)
    .expect(500, { error: { code: "PUBLICATION_FAILED" } });
  expect(console.info).toHaveBeenCalledWith("scheduled-publication", expect.objectContaining({
    processed: null, published: null, errors: 1,
  }));
});
it("returns a clean 503 on database connection failure", async () => {
  vi.mocked(connect).mockRejectedValueOnce(new Error("private connection details"));
  await request(app).get(path).set("Authorization", `Bearer ${secret}`)
    .expect(503, { error: { code: "DATABASE_UNAVAILABLE" } });
  expect(publishScheduled).not.toHaveBeenCalled();
});
