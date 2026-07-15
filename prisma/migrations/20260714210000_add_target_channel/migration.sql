-- Publisher channel per target: 'wa' | 'telegram'. String (not enum) so a
-- future channel doesn't require another migration. Existing rows default
-- to WhatsApp.
ALTER TABLE "WaTarget" ADD COLUMN "channel" TEXT NOT NULL DEFAULT 'wa';
