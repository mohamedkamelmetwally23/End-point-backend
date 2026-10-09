import { afterEach, it, expect, vi } from "vitest";
import mongoose from "mongoose";
import { connect } from "../src/shared/database.js";
afterEach(() => {
  mongoose.connection.emit("disconnected");
  vi.restoreAllMocks();
});
it("shares one in-flight MongoDB connection and reuses an established connection", async () => {
  const state = vi
    .spyOn(mongoose.connection, "readyState", "get")
    .mockReturnValue(0);
  let resolve!: (value: typeof mongoose) => void;
  const pending = new Promise<typeof mongoose>((done) => {
    resolve = done;
  });
  const open = vi.spyOn(mongoose, "connect").mockReturnValue(pending);
  const first = connect();
  const second = connect();
  expect(first).toBe(second);
  expect(open).toHaveBeenCalledTimes(1);
  resolve(mongoose);
  await first;
  state.mockReturnValue(1);
  await connect();
  expect(open).toHaveBeenCalledTimes(1);
  mongoose.connection.emit("disconnected");
  state.mockReturnValue(0);
  open.mockResolvedValue(mongoose);
  await connect();
  expect(open).toHaveBeenCalledTimes(2);
});
it("allows a new connection attempt after a failed connection", async () => {
  vi.spyOn(mongoose.connection, "readyState", "get").mockReturnValue(0);
  const open = vi
    .spyOn(mongoose, "connect")
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValueOnce(mongoose);
  await expect(connect()).rejects.toThrow("unavailable");
  await expect(connect()).resolves.toBe(mongoose);
  expect(open).toHaveBeenCalledTimes(2);
});
