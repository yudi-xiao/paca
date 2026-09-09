BEGIN;

ALTER TABLE "paca_environment_scope" ADD COLUMN "name" text;--> statement-breakpoint
UPDATE "paca_environment_scope"
SET "name" = 'Environment ' || left("environment_id"::text, 8)
WHERE "name" IS NULL;--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ALTER COLUMN "name" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD COLUMN "created_by" text;--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD CONSTRAINT "paca_environment_scope_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_environment_scope_project_name_uidx" ON "paca_environment_scope" USING btree ("project_id",lower("name")) WHERE "paca_environment_scope"."deleted_at" is null;--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD CONSTRAINT "paca_environment_scope_name_check" CHECK ("paca_environment_scope"."name" = btrim("paca_environment_scope"."name") and length("paca_environment_scope"."name") between 1 and 100);--> statement-breakpoint

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0026_nosy_gamma_corps', '198e3100326e65122c15f622c3c34a17772f00393697ac0cefedd0c8757cf1c1');

COMMIT;
