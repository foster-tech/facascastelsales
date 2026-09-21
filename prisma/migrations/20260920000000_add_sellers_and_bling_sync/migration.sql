CREATE TABLE "Seller" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "Seller_normalizedName_key" ON "Seller"("normalizedName");

CREATE TABLE "BlingOrderSync" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "shopifyOrderName" TEXT NOT NULL,
    "sellerId" TEXT,
    "sellerName" TEXT,
    "blingOrderId" TEXT,
    "webhookId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

CREATE UNIQUE INDEX "BlingOrderSync_shopDomain_shopifyOrderId_key"
ON "BlingOrderSync"("shopDomain", "shopifyOrderId");

CREATE INDEX "BlingOrderSync_status_updatedAt_idx"
ON "BlingOrderSync"("status", "updatedAt");