-- CreateTable
CREATE TABLE "PendingDeal" (
    "id" TEXT NOT NULL,
    "catalogId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "score" INTEGER NOT NULL,
    "snapshot" JSONB NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "PendingDeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingDeal_status_expiresAt_idx" ON "PendingDeal"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "PendingDeal_catalogId_status_idx" ON "PendingDeal"("catalogId", "status");
