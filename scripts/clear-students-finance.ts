import assert from "node:assert/strict";
import mongoose from "mongoose";
import { connect, transaction } from "../src/shared/database.js";
import { User, Order, Expense, Session, StudentDevice, PackageAccess, LectureProgress, StaffAssignment, AuditLog } from "../src/modules/domain/models.js";

await connect();
try {
  const students = await User.find({ role: "student" }).select("_id").lean();
  const staff = await User.find({ role: { $in: ["lecturer", "content_manager"] } }).select("_id").lean();
  const studentIds = students.map(user => user._id);
  const loginIds = [...studentIds, ...staff.map(user => user._id)];
  const summary = {
    database: mongoose.connection.name,
    roles: await User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
    students: students.length,
    orders: await Order.countDocuments(),
    expenses: await Expense.countDocuments(),
    sessions: await Session.countDocuments({ userId: { $in: loginIds } }),
    devices: await StudentDevice.countDocuments({ studentId: { $in: loginIds } }),
    access: await PackageAccess.countDocuments({ studentId: { $in: studentIds } }),
    progress: await LectureProgress.countDocuments({ studentId: { $in: studentIds } }),
  };
  console.log(JSON.stringify({ before: summary }));
  if (process.argv.includes("--apply")) {
    const target = process.argv.find(arg => arg.startsWith("--database="))?.slice(11);
    assert.equal(target, mongoose.connection.name, "Exact database target required");
    const result = await transaction(async session => {
      const preservedUsers = await User.find({ role: { $ne: "student" } }).select("_id role").session(session).lean();
      const deleted: Record<string, number> = {};
      const operations: [string, typeof User, mongoose.FilterQuery<unknown>][] = [
        ["sessions", Session, { userId: { $in: loginIds } }],
        ["devices", StudentDevice, { studentId: { $in: loginIds } }],
        ["access", PackageAccess, { studentId: { $in: studentIds } }],
        ["progress", LectureProgress, { studentId: { $in: studentIds } }],
        ["assignments", StaffAssignment, { userId: { $in: studentIds } }],
        ["orders", Order, {}],
        ["expenses", Expense, {}],
        ["audit", AuditLog, { $or: [{ actor: { $in: studentIds } }, { entityId: { $in: studentIds.map(String) } }, { entityType: { $in: ["orders", "expenses"] } }] }],
        ["students", User, { role: "student" }],
      ];
      for (const [name, model, filter] of operations) {
        deleted[name] = (await model.deleteMany(filter, { session })).deletedCount;
      }
      assert.equal(await User.countDocuments({ role: "student" }).session(session), 0);
      assert.equal(await Order.countDocuments().session(session), 0);
      assert.equal(await Expense.countDocuments().session(session), 0);
      assert.equal(await Session.countDocuments({ userId: { $in: loginIds } }).session(session), 0);
      assert.deepEqual(await User.find({ role: { $ne: "student" } }).select("_id role").session(session).lean(), preservedUsers);
      return deleted;
    });
    console.log(JSON.stringify({ deleted: result, verified: true }));
  }
} finally {
  await mongoose.disconnect();
}
