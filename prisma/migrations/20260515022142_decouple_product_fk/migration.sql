-- DropForeignKey
ALTER TABLE "PriceHistory" DROP CONSTRAINT "PriceHistory_catalogId_fkey";

-- DropForeignKey
ALTER TABLE "SentMessage" DROP CONSTRAINT "SentMessage_catalogId_fkey";

-- AlterTable
ALTER TABLE "PriceHistory" ALTER COLUMN "itemId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Product" ALTER COLUMN "title" DROP NOT NULL,
ALTER COLUMN "lastSeenAt" SET DEFAULT CURRENT_TIMESTAMP;
