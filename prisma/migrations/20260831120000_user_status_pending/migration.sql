-- AlterEnum
-- Postgres will not let a newly added enum value be USED in the same
-- transaction it is added in, so this migration only adds the value; the
-- column default that references it lives in the next migration.
ALTER TYPE "UserStatus" ADD VALUE 'PENDING' BEFORE 'ACTIVE';
