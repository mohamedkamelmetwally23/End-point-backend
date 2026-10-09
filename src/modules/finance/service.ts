import { Expense, Order } from "../domain/models.js";
import { expenseSchema } from "../domain/validation.js";
import type { Principal } from "../staff-assignments/service.js";
import { ensure } from "../../shared/errors.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
import { bindFile, cleanupFile } from "../../storage/storage.service.js";
export async function finance(user: Principal) {
  const expenses = await Expense.find(
    user.role === "super_admin" ? {} : { createdBy: user.userId },
  )
    .populate("createdBy", "fullName")
    .sort({ date: -1 })
    .lean();
  const expenseTotal = expenses.reduce((n, e) => n + Number(e.amount), 0);
  if (user.role !== "super_admin") return { expenses, expenseTotal };
  const revenueRows = await Order.aggregate([
    { $match: { status: "completed" } },
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$completedAt" } },
        amount: { $sum: "$priceSnapshot" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  const revenue = revenueRows.reduce((n, e) => n + Number(e.amount), 0);
  const byCategory = await Expense.aggregate([
    { $group: { _id: "$category", amount: { $sum: "$amount" } } },
  ]);
  const byPerson = await Expense.aggregate([
    { $group: { _id: "$createdBy", amount: { $sum: "$amount" } } },
    {
      $lookup: {
        from: "users",
        localField: "_id",
        foreignField: "_id",
        as: "person",
      },
    },
    {
      $project: { amount: 1, name: { $arrayElemAt: ["$person.fullName", 0] } },
    },
  ]);
  const monthlyExpenses = await Expense.aggregate([
    {
      $group: {
        _id: { $dateToString: { format: "%Y-%m", date: "$date" } },
        amount: { $sum: "$amount" },
      },
    },
    { $sort: { _id: 1 } },
  ]);
  return {
    expenses,
    expenseTotal,
    revenue,
    netProfit: revenue - expenseTotal,
    byCategory,
    byPerson,
    monthlyExpenses,
    monthlyRevenue: revenueRows,
  };
}
export async function saveExpense(
  user: Principal,
  body: unknown,
  entityId?: string,
) {
  const data = expenseSchema.parse(body);
  let previousFile: unknown;
  let previousReceiptUrl: unknown;
  const result = await transaction(async (session) => {
    const row = entityId
      ? await Expense.findById(entityId).session(session)
      : null;
    if (entityId) ensure(row, 404, "NOT_FOUND");
    if (row)
      ensure(
        user.role === "super_admin" || String(row.createdBy) === user.userId,
        403,
        "FORBIDDEN",
      );
    previousFile = row?.receiptImage;
    previousReceiptUrl = row?.receiptUrl;
    if (data.receiptUrl !== undefined)
      await bindFile(
        user,
        data.receiptUrl,
        previousReceiptUrl,
        "receipt",
        undefined,
        session,
      );
    if (data.receiptImage !== undefined)
      await bindFile(
        user,
        data.receiptImage?.startsWith("data:image/") ? null : data.receiptImage,
        typeof previousFile === "string" && previousFile.startsWith("data:image/") ? null : previousFile,
        "receipt",
        undefined,
        session,
      );
    const record = row
      ? await row.set(data).save({ session })
      : (
          await Expense.create([{ ...data, createdBy: user.userId }], {
            session,
          })
        )[0]!;
    await audit(
      user.userId,
      row ? "expense.updated" : "expense.created",
      "expenses",
      record._id,
      {},
      session,
    );
    return record;
  });
  if (data.receiptImage !== undefined && previousFile !== data.receiptImage)
    if (!(typeof previousFile === "string" && previousFile.startsWith("data:image/"))) await cleanupFile(previousFile);
  if (data.receiptUrl !== undefined && previousReceiptUrl !== data.receiptUrl)
    await cleanupFile(previousReceiptUrl);
  return result;
}
export async function deleteExpense(user: Principal, entityId: string) {
  let previousFile: unknown;
  let previousReceiptUrl: unknown;
  await transaction(async (session) => {
    const row = await Expense.findById(entityId).session(session);
    ensure(row, 404, "NOT_FOUND");
    ensure(
      user.role === "super_admin" || String(row.createdBy) === user.userId,
      403,
      "FORBIDDEN",
    );
    previousFile = row.receiptImage;
    previousReceiptUrl = row.receiptUrl;
    await bindFile(
      user,
      null,
      previousReceiptUrl,
      "receipt",
      undefined,
      session,
    );
    if (!(typeof previousFile === "string" && previousFile.startsWith("data:image/")))
      await bindFile(user, null, previousFile, "receipt", undefined, session);
    await row.deleteOne({ session });
    await audit(
      user.userId,
      "expense.deleted",
      "expenses",
      entityId,
      {},
      session,
    );
  });
  if (!(typeof previousFile === "string" && previousFile.startsWith("data:image/"))) await cleanupFile(previousFile);
  await cleanupFile(previousReceiptUrl);
}
