-- CreateTable
CREATE TABLE "OpsConfig" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OpsConfig_pkey" PRIMARY KEY ("key")
);
