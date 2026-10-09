import mongoose from "mongoose";
import { connect } from "../src/shared/database.js";
import { ensureAllYearTerms } from "../src/modules/academics/service.js";

try {
  await connect();
  const count = await ensureAllYearTerms();
  console.log(`Ensured first and second terms for ${count} academic years.`);
} finally {
  await mongoose.disconnect();
}
