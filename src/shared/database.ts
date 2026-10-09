import mongoose from "mongoose";
import { env } from "../config/env.js";
export const connect = () => mongoose.connect(env.MONGODB_URI);
export async function transaction<T>(
  work: (session: mongoose.ClientSession) => Promise<T>,
): Promise<T> {
  const session = await mongoose.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await work(session);
    });
    return result;
  } finally {
    await session.endSession();
  }
}
