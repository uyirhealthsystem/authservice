// Adds the authenticated caller (decoded from the access token by
// requireAuth) to Express's Request type. Only routes behind requireAuth
// populate this - everywhere else it is undefined.
import "express";

declare global {
  namespace Express {
    interface Request {
      auth?: {
        userId: string;
        role: string;
      };
    }
  }
}
