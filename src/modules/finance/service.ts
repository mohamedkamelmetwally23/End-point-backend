import { receiptPresence, receiptReference } from "../../shared/receipts.js";
import mongoose from "mongoose";
import { pageQuery } from "../../shared/pagination.js";
import { dto } from "../../shared/dto.js";
import { Expense, Order } from "../domain/models.js";
import { expenseSchema } from "../domain/validation.js";
import type { Principal } from "../staff-assignments/service.js";
import { ensure } from "../../shared/errors.js";
import { audit } from "../audit/service.js";
import { transaction } from "../../shared/database.js";
import { bindFile, cleanupFile } from "../../storage/storage.service.js";
export async function finance(user: Principal, query: unknown = {}, summaryOnly = false) {
  const { page, limit } = pageQuery.parse(query);
  const filter = user.role === "super_admin" ? {} : { createdBy: user.userId };
  const [expenses, totals] = await Promise.all([
    summaryOnly ? [] : Expense.find(filter)
      .select({ _id: 1, createdBy: 1, category: 1, amount: 1, currency: 1, date: 1, notes: 1, receiptUrl: 1, receiptImage: receiptPresence })
      .populate("createdBy", "fullName").sort({ date: -1, _id: -1 })
      .skip((page - 1) * limit).limit(limit).lean(),
    Expense.aggregate([
      { $match: user.role === "super_admin" ? {} : { createdBy: new mongoose.Types.ObjectId(user.userId) } },
      { $group: { _id: null, amount: { $sum: "$amount" }, total: { $sum: 1 } } },
    ]),
  ]);
  for (const expense of expenses) {
    expense.receiptImage = expense.receiptImage ? receiptReference(expense._id, "expenses") : undefined;
  }
  const expenseTotal = Number(totals[0]?.amount ?? 0);
  const total = Number(totals[0]?.total ?? 0);
  const pagination = { page, limit, total, hasNext: page * limit < total };
  if (user.role !== "super_admin") return { expenses, expenseTotal, pagination };
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
  if (summaryOnly) {
    const monthlyExpenses = await Expense.aggregate([
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$date" } }, amount: { $sum: "$amount" } } },
      { $sort: { _id: 1 } },
    ]);
    return { expenses, pagination, expenseTotal, revenue, netProfit: revenue - expenseTotal, monthlyExpenses, monthlyRevenue: revenueRows };
  }
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
        pipeline: [{ $project: { fullName: 1 } }],
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
    pagination,
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
    return dto(record, "_id category amount currency date notes receiptUrl receiptImage");
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
