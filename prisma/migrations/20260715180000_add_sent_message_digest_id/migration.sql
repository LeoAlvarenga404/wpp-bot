-- Fase 3: agrupa as linhas de auditoria de um mesmo digest WA.
ALTER TABLE "SentMessage" ADD COLUMN "digestId" TEXT;
