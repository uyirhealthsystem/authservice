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
  invalidLoginCode: (attemptsRemaining: number) =>
    new AppError(
      400,
      "INVALID_LOGIN_CODE",
      attemptsRemaining > 0
        ? `That code is incorrect. ${attemptsRemaining} attempt${attemptsRemaining === 1 ? "" : "s"} left.`
        : "That code is incorrect. Too many wrong attempts - please log in again.",
    ),
  loginChallengeInvalid: () =>
    new AppError(
      400,
      "LOGIN_CHALLENGE_INVALID",
      "This sign-in request has expired or is no longer valid. Please log in again.",
    ),
  tooManyRequests: (code: string, msg: string) => new AppError(429, code, msg),
  serviceUnavailable: (msg: string) => new AppError(503, "SERVICE_UNAVAILABLE", msg),
};
