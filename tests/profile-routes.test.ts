import express from "express";
import request from "supertest";
import { expect, it, vi } from "vitest";

vi.mock("../src/middleware/auth.js", () => ({
  authenticate: (req: express.Request, _res: express.Response, next: express.NextFunction) => {
    req.principal = { userId: "current-user", role: String(req.headers["x-test-role"]) };
    next();
  },
  authorize: () => (_req: express.Request, _res: express.Response, next: express.NextFunction) => next(),
}));
vi.mock("../src/modules/auth/service.js", () => ({
  profile: vi.fn(async () => ({ user: { _id: "current-user", fullName: "Kamel" } })),
  updateProfile: vi.fn(async (_id: string, body: unknown) => body),
}));

import { router } from "../src/modules/api/routes.js";
import { profile, updateProfile } from "../src/modules/auth/service.js";

const app = express();
app.use(express.json());
app.use("/api/v1", router);

it.each(["super_admin", "student", "lecturer", "content_manager"])(
  "keeps profile reads and edits available to %s at the public API prefix",
  async role => {
    const result = await request(app).get("/api/v1/profile").set("x-test-role", role).expect(200);
    expect(result.body.data.user._id).toBe("current-user");
    expect(profile).toHaveBeenLastCalledWith("current-user");
    const body = { fullName: "Updated Name", phone: "01012345678" };
    await request(app).patch("/api/v1/profile").set("x-test-role", role).send(body).expect(200);
    expect(updateProfile).toHaveBeenLastCalledWith("current-user", body);
  },
);
