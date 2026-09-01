import { prisma } from "../../lib/prisma";
import { Errors } from "../../lib/errors";

// Who may approve whom:
//   SUPER_ADMIN -> anyone (service providers AND admins)
//   ADMIN       -> service providers only, never another ADMIN or a SUPER_ADMIN
// PATIENT / SUPER_ADMIN accounts are created ACTIVE (autoApprove portals) so
// they never reach this queue.
function canApprove(actorRole: string, targetRole: string): boolean {
  if (actorRole === "SUPER_ADMIN") return true;
  if (actorRole === "ADMIN") return targetRole !== "ADMIN" && targetRole !== "SUPER_ADMIN";
  return false;
}

const publicUser = {
  id: true,
  email: true,
  role: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  createdAt: true,
  lastLoginAt: true,
} as const;

export async function listPendingUsers(actorRole: string) {
  const users = await prisma.user.findMany({
    where: { status: "PENDING" },
    select: publicUser,
    orderBy: { createdAt: "asc" },
  });
  // An ADMIN cannot action other ADMIN / SUPER_ADMIN accounts, so don't show
  // them rows they can't do anything with.
  return users.filter((u) => canApprove(actorRole, u.role));
}

async function actionable(actorRole: string, targetId: string) {
  const target = await prisma.user.findUnique({ where: { id: targetId }, select: publicUser });
  if (!target) throw Errors.notFound("User");
  if (target.status !== "PENDING") {
    throw Errors.badRequest("NOT_PENDING", `User is ${target.status}, not PENDING.`);
  }
  if (!canApprove(actorRole, target.role)) {
    throw Errors.forbidden(`An ${actorRole} cannot action a ${target.role} account.`);
  }
  return target;
}

export async function approveUser(actorId: string, actorRole: string, targetId: string) {
  await actionable(actorRole, targetId);
  return prisma.user.update({
    where: { id: targetId },
    data: { status: "ACTIVE", approvedAt: new Date(), approvedById: actorId },
    select: publicUser,
  });
}

export async function rejectUser(actorId: string, actorRole: string, targetId: string) {
  await actionable(actorRole, targetId);
  return prisma.user.update({
    where: { id: targetId },
    data: { status: "DISABLED", approvedById: actorId },
    select: publicUser,
  });
}
