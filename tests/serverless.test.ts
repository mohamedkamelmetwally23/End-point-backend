import { it, expect, vi, beforeEach, afterEach } from "vitest";
import express from "express";
import request from "supertest";
import { env } from "../src/config/env.js";
vi.mock("../src/shared/database.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/shared/database.js")>();
  return { ...actual, connect: vi.fn().mockResolvedValue(undefined) };
});
import { connect } from "../src/shared/database.js";
import { requireSummaryStorage } from "../src/shared/summary-files.js";
beforeEach(() => {
  vi.stubEnv("VERCEL", "1");
  vi.mocked(connect)
    .mockReset()
    .mockResolvedValue(undefined as never);
});
afterEach(() => vi.unstubAllEnvs());
async function serverlessApp() {
  const { default: app } = await import("../src/app.js");
  return app;
}
it("imports app and Vercel entrypoint without listening", async () => {
  const listen = vi.spyOn(express.application, "listen");
  try {
    await import("../src/app.js");
    expect(listen).not.toHaveBeenCalled();
    expect(connect).not.toHaveBeenCalled();
  } finally {
    listen.mockRestore();
  }
});
it("serves both health URLs and CORS preflight without connecting to MongoDB", async () => {
  const host = await serverlessApp();
  await request(host)
    .get("/health")
    .expect("X-Content-Type-Options", "nosniff")
    .expect("X-Frame-Options", "SAMEORIGIN")
    .expect(200, { ok: true });
  await request(host)
    .get("/api/v1/health")
    .expect(200, { data: { status: "ok" } });
  const preflight = await request(host)
    .options("/api/v1/auth/login")
    .set("Origin", env.FRONTEND_URL)
    .set("Access-Control-Request-Method", "POST")
    .expect(204);
  expect(preflight.headers["access-control-allow-origin"]).toBe(
    env.FRONTEND_URL,
  );
  expect(preflight.headers["access-control-allow-credentials"]).toBe("true");
  expect(connect).not.toHaveBeenCalled();
});
it("preserves API prefixes and rejects disallowed write origins", async () => {
  const host = await serverlessApp();
  await request(host).get("/api/v1/auth/me").expect(401);
  await request(host).get("/api/api/v1/health").expect(404);
  await request(host)
    .post("/api/v1/auth/login")
    .set("Origin", "https://untrusted.example")
    .send({})
    .expect(403);
});
it("returns a clean 503 if MongoDB cannot connect", async () => {
  vi.mocked(connect).mockRejectedValueOnce(
    new Error("private connection details"),
  );
  await request(await serverlessApp())
    .get("/api/v1/auth/me")
    .expect(503, { error: { code: "DATABASE_UNAVAILABLE" } });
});
it("reports the Vercel persistent PDF storage blocker explicitly", () => {
  vi.stubEnv("VERCEL", "1");
  try {
    expect(() => requireSummaryStorage()).toThrow(
      "PDF_STORAGE_UNAVAILABLE_ON_VERCEL",
    );
  } finally {
    vi.unstubAllEnvs();
  }
});
