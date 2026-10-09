import mongoose from "mongoose";
import bcrypt from "bcryptjs";
import { env } from "../src/config/env.js";
import { User, models } from "../src/modules/domain/models.js";
import { connect } from "../src/shared/database.js";
import { ensure } from "../src/shared/errors.js";
export function confirmedTestDatabase(name: string, environment: string) {
  ensure(
    environment !== "production" &&
      /^(test|endpoint_test|endpoint_dev|ep_rebuild_test_[a-z0-9_]+)$/.test(
        name,
      ),
    403,
    "RESET_TARGET_NOT_CONFIRMED_TEST",
  );
}
export async function seedAdmin() {
  confirmedTestDatabase(mongoose.connection.name, env.NODE_ENV);
  const email = (
    process.env.INITIAL_ADMIN_EMAIL || "kamel@endpoint.local"
  ).toLowerCase();
  const existing = await User.findOne({ email });
  if (existing) {
    ensure(existing.role === "super_admin", 409, "SEED_EMAIL_CONFLICT");
    return { email, created: false };
  }
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  ensure(
    password && password.length >= 12,
    400,
    "INITIAL_ADMIN_PASSWORD_REQUIRED",
  );
  await User.create({
    fullName: "Kamel",
    email,
    role: "super_admin",
    phone: "",
    passwordHash: await bcrypt.hash(password, 12),
  });
  return { email, created: true };
}
export async function run(reset: boolean) {
  try {
    await connect();
    confirmedTestDatabase(mongoose.connection.name, env.NODE_ENV);
    if (reset) {
      ensure(
        process.argv.includes("--delete-all-test-data"),
        400,
        "RESET_FLAG_REQUIRED",
      );
      ensure(
        process.env.INITIAL_ADMIN_PASSWORD &&
          process.env.INITIAL_ADMIN_PASSWORD.length >= 12,
        400,
        "INITIAL_ADMIN_PASSWORD_REQUIRED",
      );
      await mongoose.connection.dropDatabase();
    }
    for (const model of Object.values(models)) {
      await model.createCollection();
      await model.syncIndexes();
    }
    console.log(
      JSON.stringify({
        database: mongoose.connection.name,
        reset,
        collections: Object.keys(models),
        admin: await seedAdmin(),
      }),
    );
  } finally {
    await mongoose.disconnect();
  }
}
