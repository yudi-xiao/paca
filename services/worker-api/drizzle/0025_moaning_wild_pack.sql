BEGIN;

ALTER TABLE "paca_environment_scope" DROP CONSTRAINT "paca_environment_scope_backend_check";--> statement-breakpoint
ALTER TABLE "paca_environment_scope" ADD CONSTRAINT "paca_environment_scope_backend_check" CHECK ("paca_environment_scope"."backend" in ('cloudflare-sandbox', 'cloudflare-computer', 'legacy-agent-runner'));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0025_moaning_wild_pack', '641e9e6444f9580508948ce63de850eb30e0691555e435e49d046a272d7c4eb5');

COMMIT;
