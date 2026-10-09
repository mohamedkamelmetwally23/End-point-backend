import "dotenv/config";
import { z } from "zod";
const parsed = z
  .object({
    NODE_ENV: z
      .enum(["development", "test", "production"])
      .default("development"),
    PORT: z.coerce.number().default(4000),
    MONGODB_URI: z.string().min(1),
    FRONTEND_URL: z.string().url().default("http://localhost:5173"),
    COOKIE_SECRET: z.string().min(32),
    COOKIE_SAME_SITE: z.enum(["lax", "strict", "none"]).default("lax"),
    WHATSAPP_NUMBER: z
      .string()
      .regex(/^\d{8,15}$/)
      .optional(),
  })
  .safeParse(
    Object.fromEntries(Object.entries(process.env).filter(([, v]) => v !== "")),
  );
if (!parsed.success)
  throw new Error(
    `Invalid configuration: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
  );
export const env = parsed.data;
