import { loadReceipt, sendReceipt } from "../../shared/receipts.js";
import { Router } from "express";
import * as storage from "../../storage/storage.service.js";
import { z } from "zod";
import { endpoint } from "../../shared/http.js";
import { authenticate, authorize } from "../../middleware/auth.js";
import { id, receiptImageSchema } from "../domain/validation.js";
import { ensure } from "../../shared/errors.js";
import * as auth from "../auth/service.js";
import * as academics from "../academics/service.js";
import * as packages from "../packages/service.js";
import * as content from "../content/service.js";
import * as access from "../access/service.js";
import * as orders from "../orders/service.js";
import * as progress from "../progress/service.js";
import * as finance from "../finance/service.js";
import * as users from "../users/service.js";
import { saveAssignment, listAssignments } from "../staff-assignments/service.js";
import { frequentLoginsToday, listAudit } from "../audit/service.js";
const param = (value: unknown) => id.parse(value);
export const router = Router();
router.get("/health", (_req, res) => res.json({ data: { status: "ok", version: "profile-route-fix-1" } }));
router.get(
  "/public/academics",
  endpoint(() => academics.academics(true)),
);
router.post(
  "/auth/register",
  endpoint((req) => auth.register(req.body).then(() => ({ registered: true }))),
);
router.post(
  "/auth/login",
  endpoint((req, res) => auth.login(req, res)),
);
router.post(
  "/auth/logout",
  endpoint((req, res) => auth.logout(req, res)),
);
router.use(authenticate);
router.get(
  "/files/:filename",
  endpoint(async (req, res) => {
    const filename = z
      .string()
      .regex(/^[a-f\d]{24}\.(pdf|png|jpg|webp)$/)
      .parse(req.params.filename);
    res.setHeader("Cache-Control", "private, no-store");
    res.redirect(
      302,
      await storage.createDownloadAccess(
        req.principal,
        filename.split(".")[0]!,
      ),
    );
  }),
);
// Legacy references must be migrated; never pretend a missing local file exists.
router.get(
  "/summary-pdfs/:filename",
  endpoint(async () => {
    ensure(false, 404, "FILE_REUPLOAD_REQUIRED");
  }),
);
router.post(
  "/files/prepare",
  endpoint((req) => storage.prepareUpload(req.principal, req.body)),
);
router.post(
  "/files/:id/upload",
  endpoint(async (req, res) => {
    z.object({
      type: z.literal("blob.generate-presigned-url"),
      payload: z.object({
        pathname: z.string(),
        multipart: z.literal(false).optional(),
      }),
    }).parse(req.body);
    const result = await storage.authorizeUploadRequest(
      req,
      param(req.params.id),
    );
    res.setHeader("Cache-Control", "private, no-store");
    res.json(result);
  }),
);
router.post(
  "/files/:id/complete",
  endpoint((req) =>
    storage.completeUpload(req.principal, param(req.params.id)),
  ),
);
router.get(
  "/auth/me",
  endpoint((req) => auth.bootstrap(req.principal.userId)),
);
router.post(
  "/auth/change-password",
  endpoint((req) => auth.changePassword(req.principal.userId, req.body)),
);
router.get("/profile", endpoint((req) => auth.profile(req.principal.userId)));
router.patch("/profile", endpoint(req => auth.updateProfile(req.principal.userId, req.body)));

const student = Router();
student.use(authorize("student"));
student.get(
  "/packages",
  endpoint((req) =>
    packages.listPackages(
      req.principal,
      req.query.mode === "explore" ? "explore" : "learning",
    ),
  ),
);
student.get(
  "/packages/:id",
  endpoint((req) =>
    packages.packageDetail(
      req.principal,
      param(req.params.id),
      req.query.preview === "true",
    ),
  ),
);
student.post(
  "/packages/:id/claim",
  endpoint((req) => access.claim(req.principal, param(req.params.id))),
);
student.post(
  "/packages/:id/buy",
  endpoint((req) => {
    const data = z.object({ receiptImage: receiptImageSchema.optional() }).parse(req.body || {});
    return orders.buy(req.principal, param(req.params.id), data.receiptImage);
  }),
);
student.get(
  "/lectures/:id",
  endpoint((req) =>
    packages.lectureDetail(req.principal, param(req.params.id)),
  ),
);
student.post(
  "/lectures/:id/complete",
  endpoint((req) =>
    progress.completeLecture(req.principal, param(req.params.id)),
  ),
);
student.get(
  "/timeline",
  endpoint((req) => {
    const dates = z
      .object({ from: z.iso.datetime(), to: z.iso.datetime() })
      .refine(
        (v) =>
          new Date(v.to) > new Date(v.from) &&
          new Date(v.to).getTime() - new Date(v.from).getTime() <=
            93 * 86400000,
      )
      .parse(req.query);
    return progress.timeline(req.principal, dates.from, dates.to);
  }),
);
router.use("/student", student);
const staff = Router();
staff.use(authorize("super_admin", "content_manager", "lecturer"));
// Old multipart clients get an explicit upgrade error; large files must bypass Functions.
staff.post(
  ["/summary-pdf", "/receipt-image"],
  endpoint(async () => {
    ensure(false, 400, "DIRECT_UPLOAD_REQUIRED");
  }),
);
staff.get(
  "/dashboard",
  endpoint((req) => users.dashboard(req.principal)),
);
staff.get(
  "/packages",
  endpoint((req) => packages.listPackages(req.principal, "staff")),
);
staff.get(
  "/packages/:id",
  endpoint((req) =>
    packages.packageDetail(req.principal, param(req.params.id)),
  ),
);
staff.get(
  "/lectures/:id",
  endpoint((req) =>
    packages.lectureDetail(req.principal, param(req.params.id)),
  ),
);
staff.post(
  "/lectures",
  endpoint((req) => content.saveLecture(req.principal, req.body)),
);
staff.put(
  "/lectures/:id",
  endpoint((req) =>
    content.saveLecture(req.principal, req.body, param(req.params.id)),
  ),
);
staff.delete(
  "/lectures/:id",
  endpoint((req) =>
    content.deleteDraft(req.principal, "lectures", param(req.params.id)),
  ),
);
staff.post(
  "/materials",
  endpoint((req) => content.saveMaterial(req.principal, req.body)),
);
staff.put(
  "/materials/:id",
  endpoint((req) =>
    content.saveMaterial(req.principal, req.body, param(req.params.id)),
  ),
);
staff.delete(
  "/materials/:id",
  endpoint((req) =>
    content.deleteDraft(req.principal, "materials", param(req.params.id)),
  ),
);
staff.get(
  "/students",
  authorize("lecturer", "super_admin"),
  endpoint((req) => users.lecturerStudents(req.principal, req.query)),
);
staff.get(
  "/finance",
  endpoint((req) => finance.finance(req.principal, req.query)),
);
staff.get("/expenses/:id/receipt", endpoint(async (req, res) => {
  sendReceipt(res, await loadReceipt(req.principal, "expenses", param(req.params.id)));
}));
staff.post(
  "/expenses",
  endpoint((req) => finance.saveExpense(req.principal, req.body)),
);
staff.put(
  "/expenses/:id",
  endpoint((req) =>
    finance.saveExpense(req.principal, req.body, param(req.params.id)),
  ),
);
staff.delete(
  "/expenses/:id",
  endpoint((req) => finance.deleteExpense(req.principal, param(req.params.id))),
);
router.use("/staff", staff);
const admin = Router();
admin.use(authorize("super_admin"));
admin.get(
  "/academics",
  endpoint(() => academics.academics()),
);
admin.post(
  "/academics/:kind",
  endpoint((req) =>
    academics.saveAcademic(
      req.principal.userId,
      String(req.params.kind),
      req.body,
    ),
  ),
);
admin.put(
  "/academics/:kind/:id",
  endpoint((req) =>
    academics.saveAcademic(
      req.principal.userId,
      String(req.params.kind),
      req.body,
      param(req.params.id),
    ),
  ),
);
admin.post(
  "/packages",
  endpoint((req) => packages.savePackage(req.principal.userId, req.body)),
);
admin.put(
  "/packages/:id",
  endpoint((req) =>
    packages.savePackage(req.principal.userId, req.body, param(req.params.id)),
  ),
);
admin.post(
  "/packages/:id/subjects",
  endpoint((req) =>
    packages.addSubject(req.principal.userId, param(req.params.id), req.body),
  ),
);
admin.get(
  "/users",
  endpoint((req) => {
    const role = z
      .enum(["student", "lecturer", "content_manager", "super_admin"])
      .parse(req.query.role);
    return users.listUsers(role, req.query);
  }),
);
admin.post(
  "/users",
  endpoint((req) => users.createStaff(req.principal.userId, req.body)),
);
admin.patch(
  "/users/:id",
  endpoint((req) =>
    users.updateUser(req.principal.userId, param(req.params.id), req.body),
  ),
);
admin.get(
  "/students/:id",
  endpoint((req) => users.studentInspection(param(req.params.id))),
);
admin.post(
  "/students/:id/reset-device",
  endpoint((req) =>
    access.resetDevice(req.principal.userId, param(req.params.id)),
  ),
);
admin.post(
  "/students/:id/access",
  endpoint((req) => {
    const data = z
      .object({ packageId: id, revoke: z.boolean().default(false) })
      .parse(req.body);
    return access.manualAccess(
      req.principal.userId,
      param(req.params.id),
      data.packageId,
      data.revoke,
    );
  }),
);
admin.get(
  "/assignments",
  endpoint(() => listAssignments()),
);
admin.post(
  "/assignments",
  endpoint((req) => saveAssignment(req.principal.userId, req.body)),
);
admin.get(
  "/orders",
  endpoint((req) => {
    const status = z
      .enum(["pending", "completed", "cancelled"])
      .parse(req.query.status || "pending");
    return orders.listOrders(status, req.query);
  }),
);
admin.get("/orders/:id/receipt", endpoint(async (req, res) => {
  sendReceipt(res, await loadReceipt(req.principal, "orders", param(req.params.id)));
}));
admin.post(
  "/orders/:id/complete",
  endpoint((req) =>
    orders.resolveOrder(req.principal.userId, param(req.params.id), true),
  ),
);
admin.post(
  "/orders/:id/cancel",
  endpoint((req) =>
    orders.resolveOrder(req.principal.userId, param(req.params.id), false),
  ),
);
admin.get("/audit", endpoint((req) => listAudit(req.query)));
admin.get("/audit/frequent-logins", endpoint(() => frequentLoginsToday()));
admin.get("/audit/other-devices", endpoint((req) => listAudit(req.query, true)));
router.use("/admin", admin);
