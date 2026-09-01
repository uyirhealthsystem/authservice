import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { toPublicJWKS } from "../../lib/keys";

export const jwksRouter = Router();

// This is the contract every other microservice relies on: fetch this once
// (and cache/refresh on a `kid` miss), verify RS256 access tokens locally,
// no network call back to authservice per-request.
jwksRouter.get(
  "/.well-known/jwks.json",
  asyncHandler(async (_req, res) => {
    res.json(await toPublicJWKS());
  }),
);
