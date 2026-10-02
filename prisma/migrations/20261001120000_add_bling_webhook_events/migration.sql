ALTER TYPE "BlingOrderSyncStatus" ADD VALUE IF NOT EXISTS 'PROCESSING';

CREATE TYPE "BlingWebhookEventStatus" AS ENUM (
    'PENDING',
    'PROCESSING',
    'PROCESSED',
    'IGNORED',
    'FAILED'
);

CREATE TABLE "BlingWebhookEvent" (
    "eventId" TEXT NOT NULL,
    "event" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "blingOrderId" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "BlingWebhookEventStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "syncId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BlingWebhookEvent_pkey" PRIMARY KEY ("eventId")
);

CREATE INDEX "BlingWebhookEvent_status_updatedAt_idx"
ON "BlingWebhookEvent"("status", "updatedAt");

CREATE INDEX "BlingWebhookEvent_shopifyOrderId_idx"
ON "BlingWebhookEvent"("shopifyOrderId");

CREATE INDEX "BlingWebhookEvent_syncId_idx"
ON "BlingWebhookEvent"("syncId");

ALTER TABLE "BlingWebhookEvent"
ADD CONSTRAINT "BlingWebhookEvent_syncId_fkey"
FOREIGN KEY ("syncId") REFERENCES "BlingOrderSync"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
