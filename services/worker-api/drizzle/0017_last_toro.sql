BEGIN;

ALTER TABLE "paca_document" ADD COLUMN "yjs_revision" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_document" ADD COLUMN "yjs_snapshot_key" text;--> statement-breakpoint
ALTER TABLE "paca_document" ADD COLUMN "yjs_snapshot_sha256" text;--> statement-breakpoint
ALTER TABLE "paca_document" ADD COLUMN "yjs_snapshot_bytes" bigint;--> statement-breakpoint
ALTER TABLE "paca_document" ADD COLUMN "yjs_snapshot_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paca_document" ADD CONSTRAINT "paca_document_yjs_revision_check" CHECK ("paca_document"."yjs_revision" >= 0);--> statement-breakpoint
ALTER TABLE "paca_document" ADD CONSTRAINT "paca_document_yjs_snapshot_bytes_check" CHECK ("paca_document"."yjs_snapshot_bytes" is null or "paca_document"."yjs_snapshot_bytes" >= 0);

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0017_last_toro', '9c62ce37f0cf560a482e04332a00e1a42cb382b8a78d0c5f835c38ea1c3214cf');

COMMIT;
