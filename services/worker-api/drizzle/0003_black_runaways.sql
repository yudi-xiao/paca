BEGIN;

DROP INDEX "paca_project_role_project_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "paca_project_role_project_name_uidx" ON "paca_project_role" USING btree ("project_id",lower("name"));

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0003_black_runaways', '53571284c64ad2fa8dac6909ac60a641e26c417812b9c4395579aa2429b6d4ec');

COMMIT;
