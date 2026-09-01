import { z } from "zod";

export const userIdParamSchema = z.object({
  id: z.string().uuid("A user id (uuid) is required."),
});
