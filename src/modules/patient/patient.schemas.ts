import { z } from "zod";

export const GENDERS = ["MALE", "FEMALE", "OTHER"] as const;
export const BLOOD_GROUPS = ["A+", "A-", "B+", "B-", "AB+", "AB-", "O+", "O-"] as const;
export const RELATIONSHIPS = [
  "SPOUSE",
  "FATHER",
  "MOTHER",
  "SON",
  "DAUGHTER",
  "BROTHER",
  "SISTER",
  "GRANDPARENT",
  "GRANDCHILD",
  "OTHER",
] as const;

// "YYYY-MM-DD", not in the future. Stored in a DATE column.
const dateOfBirth = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "dateOfBirth must be YYYY-MM-DD.")
  .transform((s) => new Date(`${s}T00:00:00.000Z`))
  .refine((d) => !Number.isNaN(d.getTime()) && d <= new Date(), "dateOfBirth must be a valid past date.");

const personFields = {
  fullName: z.string().trim().min(1, "fullName is required.").max(200),
  dateOfBirth: dateOfBirth.nullish(),
  gender: z.enum(GENDERS).nullish(),
  phone: z.string().trim().min(5).max(20).nullish(),
  bloodGroup: z.enum(BLOOD_GROUPS).nullish(),
  district: z.string().trim().min(1).max(100).nullish(),
  pinCode: z
    .string()
    .trim()
    .regex(/^[1-9]\d{5}$/, "pinCode must be a 6-digit PIN code.")
    .nullish(),
};

// PUT /api/v1/auth/patients/me/profile - create the profile, or replace it.
export const profileSchema = z.object({
  ...personFields,
  address: z.string().trim().max(500).nullish(),
});

// POST /api/v1/auth/patients/me/family-members
export const createFamilyMemberSchema = z.object({
  ...personFields,
  relationship: z.enum(RELATIONSHIPS),
});

// PATCH /api/v1/auth/patients/me/family-members/:id - any subset of fields.
export const updateFamilyMemberSchema = createFamilyMemberSchema
  .partial()
  .refine((b) => Object.keys(b).length > 0, "Send at least one field to update.");

export const familyMemberIdParamSchema = z.object({
  id: z.string().uuid("A family member id (uuid) is required."),
});
