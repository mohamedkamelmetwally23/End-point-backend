import "dotenv/config";
import mongoose from "mongoose";
import { connect } from "../src/shared/database.js";
import {
  StoredFile,
  protectReferencedFile,
  fileReference,
} from "../src/storage/storage.service.js";
import {
  blobProvider,
  type Visibility,
} from "../src/storage/vercel-blob.provider.js";
try {
  await connect();
  const rows = await StoredFile.find({
    references: 0,
    $or: [
      { status: "deleting" },
      { updatedAt: { $lt: new Date(Date.now() - 86400000) } },
    ],
  });
  for (const row of rows) {
    console.log(
      String(row._id),
      row.status,
      process.argv.includes("--apply") ? "cleanup" : "dry-run",
    );
    if (!process.argv.includes("--apply")) continue;
    const locked = await StoredFile.findOneAndUpdate(
      { _id: row._id, references: 0, status: row.status },
      { $set: { status: "deleting" } },
    );
    if (!locked) continue;
    try {
      if (
        await protectReferencedFile(row as Parameters<typeof fileReference>[0])
      )
        continue;
      await blobProvider.delete(row.pathname!, row.visibility as Visibility);
      await row.deleteOne();
    } catch {
      console.error("CLEANUP_RETRY_REQUIRED", String(row._id));
      process.exitCode = 1;
    }
  }
} finally {
  await mongoose.disconnect();
}
