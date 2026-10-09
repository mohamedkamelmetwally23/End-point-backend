import { Order, PackageAccess } from "../domain/models.js";
import { studentPackage } from "../packages/service.js";
import { grant } from "../access/service.js";
import type { Principal } from "../staff-assignments/service.js";
import { transaction } from "../../shared/database.js";
import { audit } from "../audit/service.js";
import { ensure } from "../../shared/errors.js";
import { bindFile } from "../../storage/storage.service.js";
export async function buy(user: Principal, packageId: string, receiptImage?: string) {
  const pkg = await studentPackage(user, packageId, false);
  ensure(!pkg.isFree, 400, "PACKAGE_IS_FREE");
  ensure(
    !(await PackageAccess.exists({
      studentId: user.userId,
      packageId,
      status: "active",
    })),
    409,
    "ALREADY_OWNED",
  );
  const order = await transaction(async (session) => {
    let row = await Order.findOne({
      studentId: user.userId,
      packageId,
      status: "pending",
    }).session(session);
    if (!row) {
      row = (
        await Order.create(
          [{ studentId: user.userId, packageId, priceSnapshot: pkg.price }],
          { session },
        )
      )[0]!;
      await audit(user.userId, "order.created", "orders", row._id, {}, session);
    }
    if (receiptImage) {
      await bindFile(user, receiptImage, row.receiptImage, "receipt", undefined, session);
      row.receiptImage = receiptImage;
      await row.save({ session });
    }
    return row;
  });
  return {
    order,
  };
}
export async function resolveOrder(
  actor: unknown,
  orderId: string,
  complete: boolean,
) {
  return transaction(async (session) => {
    const order = await Order.findById(orderId).session(session);
    ensure(order, 404, "NOT_FOUND");
    if (order.status === "completed" && complete) return order;
    ensure(order.status === "pending", 409, "ORDER_NOT_PENDING");
    order.status = complete ? "completed" : "cancelled";
    if (complete) {
      order.completedAt = new Date();
      order.completedBy = actor;
      await grant(
        order.studentId,
        order.packageId,
        "paid_order",
        actor,
        session,
      );
    }
    await order.save({ session });
    await audit(
      actor,
      complete ? "order.completed" : "order.cancelled",
      "orders",
      order._id,
      {},
      session,
    );
    return order;
  });
}
