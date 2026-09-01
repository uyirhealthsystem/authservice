-- AlterTable
ALTER TABLE "users" ADD COLUMN "approvedAt" TIMESTAMP(3),
ADD COLUMN "approvedById" TEXT;

-- Existing rows predate the approval workflow; treat them as already approved
-- so this migration does not lock anyone out.
UPDATE "users" SET "approvedAt" = "createdAt" WHERE "status" = 'ACTIVE';

-- New rows default to PENDING and must be approved by an ADMIN / SUPER_ADMIN
-- (or be created through an autoApprove portal, which sets status explicitly).
ALTER TABLE "users" ALTER COLUMN "status" SET DEFAULT 'PENDING';
