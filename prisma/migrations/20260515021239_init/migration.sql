-- CreateTable
CREATE TABLE "Product" (
    "catalogId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "thumbnail" TEXT,
    "domainId" TEXT,
    "lastSeenAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("catalogId")
);

-- CreateTable
CREATE TABLE "PriceHistory" (
    "id" BIGSERIAL NOT NULL,
    "catalogId" TEXT NOT NULL,
    "itemId" TEXT NOT NULL,
    "priceCents" INTEGER NOT NULL,
    "originalPriceCents" INTEGER,
    "capturedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PriceHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SentMessage" (
    "id" BIGSERIAL NOT NULL,
    "catalogId" TEXT NOT NULL,
    "targetJid" TEXT NOT NULL,
    "caption" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SentMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AffiliateLink" (
    "catalogId" TEXT NOT NULL,
    "shortUrl" TEXT NOT NULL,
    "longUrl" TEXT,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("catalogId")
);

-- CreateTable
CREATE TABLE "MlToken" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "accessToken" TEXT NOT NULL,
    "refreshToken" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "userId" BIGINT,
    "scope" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MlToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DedupEntry" (
    "catalogId" TEXT NOT NULL,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DedupEntry_pkey" PRIMARY KEY ("catalogId")
);

-- CreateTable
CREATE TABLE "WaCounter" (
    "id" TEXT NOT NULL,
    "bucket" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WaCounter_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WaTarget" (
    "jid" TEXT NOT NULL,
    "name" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "WaTarget_pkey" PRIMARY KEY ("jid")
);

-- CreateTable
CREATE TABLE "WaOptout" (
    "jid" TEXT NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WaOptout_pkey" PRIMARY KEY ("jid")
);

-- CreateIndex
CREATE INDEX "PriceHistory_catalogId_capturedAt_idx" ON "PriceHistory"("catalogId", "capturedAt");

-- CreateIndex
CREATE INDEX "SentMessage_catalogId_sentAt_idx" ON "SentMessage"("catalogId", "sentAt");

-- CreateIndex
CREATE INDEX "DedupEntry_postedAt_idx" ON "DedupEntry"("postedAt");

-- AddForeignKey
ALTER TABLE "PriceHistory" ADD CONSTRAINT "PriceHistory_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Product"("catalogId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SentMessage" ADD CONSTRAINT "SentMessage_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "Product"("catalogId") ON DELETE RESTRICT ON UPDATE CASCADE;
