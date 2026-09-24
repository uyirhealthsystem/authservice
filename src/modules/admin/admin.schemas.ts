import { z } from "zod";

export const userIdParamSchema = z.object({
  id: z.string().uuid("A user id (uuid) is required."),
});

// GET /users?status=PENDING - PENDING is the only listing admins need today.
// Required rather than defaulted so a future ?status=ACTIVE is an additive
// change, not a silent change of meaning for callers that omitted it.
export const listUsersQuerySchema = z.object({
  status: z.literal("PENDING", { message: "status=PENDING is required." }),
});
