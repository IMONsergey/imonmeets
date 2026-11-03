export type Role = "owner" | "admin" | "member";
export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public retryAfter?: number,
  ) {
    super(message);
  }
}
export function assert(
  condition: unknown,
  status: number,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new ApiError(status, code, message);
}
export function canManage(
  role: Role | undefined,
  creator: string,
  userId: string | undefined,
) {
  return !!role && (role === "owner" || role === "admin" || creator === userId);
}
export function canInvite(actor: Role, target: "admin" | "member") {
  return actor === "owner" || (actor === "admin" && target === "member");
}
export function canRemove(actor: Role, target: Role) {
  return (
    target !== "owner" &&
    (actor === "owner" || (actor === "admin" && target === "member"))
  );
}
export function validOrigin(origin: string | undefined, expected: string) {
  return origin === expected;
}
