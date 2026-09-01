export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "AppError";
  }
}

export const Errors = {
  invalidCredentials: () =>
    new AppError(401, "INVALID_CREDENTIALS", "Invalid email or password."),
  notAuthenticated: () => new AppError(401, "NOT_AUTHENTICATED", "Missing or invalid token."),
  forbidden: (msg = "You do not have permission to do this.") =>
    new AppError(403, "FORBIDDEN", msg),
  pendingApproval: () =>
    new AppError(403, "PENDING_APPROVAL", "Your account is awaiting administrator approval."),
  accountDisabled: () => new AppError(403, "ACCOUNT_DISABLED", "This account has been disabled."),
  notFound: (what: string) => new AppError(404, "NOT_FOUND", `${what} not found.`),
  conflict: (code: string, msg: string) => new AppError(409, "CONFLICT_" + code, msg),
  badRequest: (code: string, msg: string) => new AppError(400, code, msg),
  serviceUnavailable: (msg: string) => new AppError(503, "SERVICE_UNAVAILABLE", msg),
};
