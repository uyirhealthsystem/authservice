import { z } from "zod";
import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";
import { profileSchema, createFamilyMemberSchema, updateFamilyMemberSchema } from "./patient.schemas";

// Every function here is scoped to the calling patient's own userId (from
// their access token) - a patient can only ever see / change their own rows.

const profileSelect = {
  id: true,
  fullName: true,
  dateOfBirth: true,
  gender: true,
  phone: true,
  bloodGroup: true,
  address: true,
  district: true,
  pinCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

const familyMemberSelect = {
  id: true,
  fullName: true,
  relationship: true,
  dateOfBirth: true,
  gender: true,
  phone: true,
  bloodGroup: true,
  district: true,
  pinCode: true,
  createdAt: true,
  updatedAt: true,
} as const;

export async function getProfile(userId: string) {
  const profile = await prisma.patientProfile.findUnique({ where: { userId }, select: profileSelect });
  if (!profile) throw Errors.notFound("Patient profile");
  return profile;
}

// Create-or-replace. Returns `created` so the route can answer 201 vs 200.
export async function upsertProfile(userId: string, data: z.infer<typeof profileSchema>) {
  const existed = await prisma.patientProfile.findUnique({ where: { userId }, select: { id: true } });
  // Omitted optional fields are cleared on a replace, not left as they were.
  const full = {
    fullName: data.fullName,
    dateOfBirth: data.dateOfBirth ?? null,
    gender: data.gender ?? null,
    phone: data.phone ?? null,
    bloodGroup: data.bloodGroup ?? null,
    address: data.address ?? null,
    district: data.district ?? null,
    pinCode: data.pinCode ?? null,
  };
  const profile = await prisma.patientProfile.upsert({
    where: { userId },
    create: { userId, ...full },
    update: full,
    select: profileSelect,
  });
  return { profile, created: !existed };
}

export function listFamilyMembers(userId: string) {
  return prisma.familyMember.findMany({
    where: { userId },
    select: familyMemberSelect,
    orderBy: { createdAt: "asc" },
  });
}

export function createFamilyMember(userId: string, data: z.infer<typeof createFamilyMemberSchema>) {
  return prisma.familyMember.create({ data: { userId, ...data }, select: familyMemberSelect });
}

// 404 (not 403) for someone else's member, so ids can't be probed.
async function ownedMember(userId: string, id: string) {
  const member = await prisma.familyMember.findFirst({ where: { id, userId }, select: { id: true } });
  if (!member) throw Errors.notFound("Family member");
}

export async function updateFamilyMember(
  userId: string,
  id: string,
  data: z.infer<typeof updateFamilyMemberSchema>,
) {
  await ownedMember(userId, id);
  return prisma.familyMember.update({ where: { id }, data, select: familyMemberSelect });
}

export async function deleteFamilyMember(userId: string, id: string) {
  await ownedMember(userId, id);
  await prisma.familyMember.delete({ where: { id } });
}
