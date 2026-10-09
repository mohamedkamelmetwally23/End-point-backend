export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message = code,
  ) {
    super(message);
  }
}
export function ensure(
  condition: unknown,
  status: number,
  code: string,
): asserts condition {
  if (!condition) throw new ApiError(status, code);
}
