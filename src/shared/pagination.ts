import { z } from "zod";
export const pageQuery = z.object({
  page: z.coerce.number().int().min(1).max(100000).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export class PageResult<T> {
  constructor(public data: T[], public pagination: { page: number; limit: number; total: number; hasNext: boolean }) {}
}
export function pageResult<T>(data: T[], total: number, page: number, limit: number) {
  return new PageResult(data, { page, limit, total, hasNext: page * limit < total });
}
