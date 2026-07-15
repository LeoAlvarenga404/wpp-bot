/*
  Warnings:

  - The primary key for the `AffiliateLink` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - You are about to drop the column `catalogId` on the `AffiliateLink` table. All the data in the column will be lost.
  - Made the column `longUrl` on table `AffiliateLink` required. This step will fail if there are existing NULL values in that column.

*/
-- AlterTable
ALTER TABLE "AffiliateLink" DROP CONSTRAINT "AffiliateLink_pkey",
DROP COLUMN "catalogId",
ALTER COLUMN "longUrl" SET NOT NULL,
ADD CONSTRAINT "AffiliateLink_pkey" PRIMARY KEY ("longUrl");
