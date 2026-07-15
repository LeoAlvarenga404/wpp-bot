-- Curation decision audit (Fase 2). One row per (catalogId, stage, day);
-- repeats increment "count". stage/outcome are TEXT, not enums, so new
-- stages don't require another migration.
CREATE TABLE "CurationDecision" (
    "id" BIGSERIAL NOT NULL,
    "catalogId" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,
    "day" TEXT NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 1,
    "score" INTEGER,
    "priceCents" INTEGER,
    "reasons" JSONB,
    "judgeVerdict" JSONB,
    "variant" TEXT,
    "firstAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CurationDecision_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "CurationDecision_catalogId_stage_day_key"
    ON "CurationDecision"("catalogId", "stage", "day");

CREATE INDEX "CurationDecision_day_stage_idx"
    ON "CurationDecision"("day", "stage");

-- Copy A/B variant on the send audit row.
ALTER TABLE "SentMessage" ADD COLUMN "variant" TEXT;
