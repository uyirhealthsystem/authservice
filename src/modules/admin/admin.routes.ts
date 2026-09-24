import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/authGuard";
import { userIdParamSchema, listUsersQuerySchema } from "./admin.schemas";
import { listPendingUsers, approveUser, rejectUser } from "./admin.service";

// Every route here requires a valid ADMIN or SUPER_ADMIN access token.
const adminOnly = requireAuth("ADMIN", "SUPER_ADMIN");

export const adminRouter = Router();

adminRouter.use("/users", adminOnly);

adminRouter.get(
  "/users",
  asyncHandler(async (req, res) => {
    listUsersQuerySchema.parse(req.query);
    const users = await listPendingUsers(req.auth!.role);
    res.status(200).json({ users });
  }),
);

adminRouter.post(
  "/users/:id/approve",
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const user = await approveUser(req.auth!.userId, req.auth!.role, id);
    res.status(200).json({ user });
  }),
);

adminRouter.post(
  "/users/:id/reject",
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const user = await rejectUser(req.auth!.userId, req.auth!.role, id);
    res.status(200).json({ user });
  }),
);

// Legacy GET /admin/users/pending. Mounted at /admin ahead of adminRouter
// (which serves the approve/reject aliases there). Delete with the aliases.
export const legacyAdminRouter = Router();

legacyAdminRouter.get(
  "/users/pending",
  adminOnly,
  asyncHandler(async (req, res) => {
    const users = await listPendingUsers(req.auth!.role);
    res.status(200).json({ users });
  }),
);
