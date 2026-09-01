import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/authGuard";
import { userIdParamSchema } from "./admin.schemas";
import { listPendingUsers, approveUser, rejectUser } from "./admin.service";

export const adminRouter = Router();

// Every route here requires a valid ADMIN or SUPER_ADMIN access token.
adminRouter.use("/admin", requireAuth("ADMIN", "SUPER_ADMIN"));

adminRouter.get(
  "/admin/users/pending",
  asyncHandler(async (req, res) => {
    const users = await listPendingUsers(req.auth!.role);
    res.status(200).json({ users });
  }),
);

adminRouter.post(
  "/admin/users/:id/approve",
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const user = await approveUser(req.auth!.userId, req.auth!.role, id);
    res.status(200).json({ user });
  }),
);

adminRouter.post(
  "/admin/users/:id/reject",
  asyncHandler(async (req, res) => {
    const { id } = userIdParamSchema.parse(req.params);
    const user = await rejectUser(req.auth!.userId, req.auth!.role, id);
    res.status(200).json({ user });
  }),
);
