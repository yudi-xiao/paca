BEGIN;

ALTER TABLE "paca_file" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD COLUMN "purge_after" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD COLUMN "purge_started_at" timestamp with time zone;--> statement-breakpoint
UPDATE "paca_task_attachment"
SET "purge_after" = "deleted_at" + interval '30 days'
WHERE "deleted_at" is not null;--> statement-breakpoint
CREATE INDEX "paca_task_attachment_purge_due_idx" ON "paca_task_attachment" USING btree ("purge_after") WHERE "paca_task_attachment"."deleted_at" is not null;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD CONSTRAINT "paca_task_attachment_retention_check" CHECK (("paca_task_attachment"."deleted_at" is null and "paca_task_attachment"."purge_after" is null and "paca_task_attachment"."purge_started_at" is null) or ("paca_task_attachment"."deleted_at" is not null and "paca_task_attachment"."purge_after" is not null));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0011_closed_next_avengers', 'a827d52d924bdfe50f9c2cc41f96ddaab7c9ef2bd2b14de28b69ec7c9ea4855f');

COMMIT;
