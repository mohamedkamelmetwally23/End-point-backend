// Field allowlists are shared with query projections to keep reads and responses aligned.
export const fields = {
  user: "_id fullName email phone role status collegeId academicYearId",
  package: "_id name description collegeId academicYearId termId price currency isFree coverUrl status",
  subject: "_id packageId subjectId order status",
  lecture: "_id packageSubjectId title description order duration youtubeUrl summaryUrl status scheduledAt publishedAt",
  material: "_id lectureId type title url body order",
  audit: "_id actor action entityType entityId timestamp",
  order: "_id studentId packageId priceSnapshot status receiptImage createdAt",
  assignment: "_id userId scopeType packageId packageSubjectId permissions active",
} as const;
export function dto(value: object, projection: string): Record<string, unknown> & { _id: unknown };
export function dto(value: unknown, projection: string): (Record<string, unknown> & { _id: unknown }) | null;
export function dto(value: unknown, projection: string): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  const source = "toObject" in value && typeof value.toObject === "function"
    ? value.toObject() as Record<string, unknown> : value as Record<string, unknown>;
  return Object.fromEntries(projection.split(" ").filter(key => source[key] !== undefined).map(key => [key, source[key]]));
}
