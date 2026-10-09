import mongoose from "mongoose";
import { app } from "./app.js";
import { connect } from "./shared/database.js";
import { env } from "./config/env.js";
import { models } from "./modules/domain/models.js";
import { publishScheduled } from "./modules/content/service.js";
await connect();
await Promise.all(Object.values(models).map((m) => m.init()));
await publishScheduled();
const server = app.listen(env.PORT, () =>
  console.log(`Endpoint API listening on ${env.PORT}`),
);
let running = false;
const timer = setInterval(async () => {
  if (running) return;
  running = true;
  try {
    await publishScheduled();
  } catch {
    console.error("Scheduled publication failed");
  } finally {
    running = false;
  }
}, 15000);
async function shutdown() {
  clearInterval(timer);
  server.close();
  await mongoose.disconnect();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
