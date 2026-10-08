import { Router } from "express";
import { asyncHandler } from "../../lib/asyncHandler";
import { requireAuth } from "../../middleware/authGuard";
import {
  profileSchema,
  createFamilyMemberSchema,
  updateFamilyMemberSchema,
  familyMemberIdParamSchema,
} from "./patient.schemas";
import {
  getProfile,
  upsertProfile,
  listFamilyMembers,
  createFamilyMember,
  updateFamilyMember,
  deleteFamilyMember,
} from "./patient.service";

// Patient profile + family members. PATIENT role only - any other role's
// token gets 403. "me" = the caller; a patient never addresses another
// patient's data.
export const patientRouter = Router();

patientRouter.use("/patients", requireAuth("PATIENT"));

patientRouter.get(
  "/patients/me/profile",
  asyncHandler(async (req, res) => {
    const profile = await getProfile(req.auth!.userId);
    res.status(200).json({ profile });
  }),
);

patientRouter.put(
  "/patients/me/profile",
  asyncHandler(async (req, res) => {
    const body = profileSchema.parse(req.body);
    const { profile, created } = await upsertProfile(req.auth!.userId, body);
    res.status(created ? 201 : 200).json({ profile });
  }),
);

patientRouter.get(
  "/patients/me/family-members",
  asyncHandler(async (req, res) => {
    const familyMembers = await listFamilyMembers(req.auth!.userId);
    res.status(200).json({ familyMembers });
  }),
);

patientRouter.post(
  "/patients/me/family-members",
  asyncHandler(async (req, res) => {
    const body = createFamilyMemberSchema.parse(req.body);
    const familyMember = await createFamilyMember(req.auth!.userId, body);
    res.status(201).json({ familyMember });
  }),
);

patientRouter.patch(
  "/patients/me/family-members/:id",
  asyncHandler(async (req, res) => {
    const { id } = familyMemberIdParamSchema.parse(req.params);
    const body = updateFamilyMemberSchema.parse(req.body);
    const familyMember = await updateFamilyMember(req.auth!.userId, id, body);
    res.status(200).json({ familyMember });
  }),
);

patientRouter.delete(
  "/patients/me/family-members/:id",
  asyncHandler(async (req, res) => {
    const { id } = familyMemberIdParamSchema.parse(req.params);
    await deleteFamilyMember(req.auth!.userId, id);
    res.status(204).end();
  }),
);
