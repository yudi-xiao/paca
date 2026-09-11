BEGIN;

ALTER TABLE "paca_environment_scope" DROP CONSTRAINT "paca_environment_scope_backend_check";--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD CONSTRAINT "paca_environment_scope_backend_check" CHECK ("paca_environment_scope"."backend" in ('cloudflare-sandbox', 'cloudflare-computer'));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0028_unknown_thunderbolts', '3c75700c9d475b3636b820e8d5e83197c00b3d75d7c7b33031d3d1147d1f5651');

COMMIT;
