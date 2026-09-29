-- CreateEnum
CREATE TYPE "BlingOrderSyncStatus"
AS ENUM ('PENDING', 'SYNCED', 'FAILED');

-- AlterTable
ALTER TABLE "BlingOrderSync"
DROP COLUMN "status",
ADD COLUMN "status" "BlingOrderSyncStatus"
NOT NULL DEFAULT 'PENDING';

-- CreateIndex
CREATE INDEX "BlingOrderSync_status_updatedAt_idx"
ON "BlingOrderSync"("status", "updatedAt");