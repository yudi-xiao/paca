BEGIN;

ALTER TABLE "paca_project" ADD COLUMN "task_id_prefix" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_project" ADD COLUMN "is_public" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_project" ADD COLUMN "settings" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_project_organization_name_uidx" ON "paca_project" USING btree ("organization_id",lower("name"));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0002_wooden_shaman', '308710bda611f88de5459e08e6d4ee73f72211e36f35cbba8ad98b2630ad910c');

COMMIT;
