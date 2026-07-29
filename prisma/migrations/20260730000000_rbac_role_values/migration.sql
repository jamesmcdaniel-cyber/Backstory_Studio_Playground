-- Two new org roles. USER is deliberately NOT renamed to MEMBER: it remains
-- the member tier, so no row is rewritten and the free-text Invitation.role
-- values ('ADMIN' | 'USER') stay valid without a backfill.
--
-- Own migration file: Postgres forbids USING a new enum value in the same
-- transaction that adds it, and Prisma runs each migration in one transaction.
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'OWNER';
ALTER TYPE "UserRole" ADD VALUE IF NOT EXISTS 'VIEWER';
