BEGIN;

DROP INDEX "paca_organization_role_organization_name_uidx";--> statement-breakpoint
CREATE UNIQUE INDEX "paca_organization_role_organization_name_uidx" ON "paca_organization_role" USING btree ("organization_id",lower("name"));

INSERT INTO "paca_organization_role_permission" ("role_id", "resource", "action") VALUES
	('00000000-0000-4000-8000-000000000101', 'organizationMembers', '*'),
	('00000000-0000-4000-8000-000000000101', 'organizationRoles', '*'),
	('00000000-0000-4000-8000-000000000102', 'organizationMembers', 'read'),
	('00000000-0000-4000-8000-000000000102', 'organizationRoles', 'read')
ON CONFLICT DO NOTHING;

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0004_melodic_gargoyle', 'cac7166f141ca1e52dc7fd31d48997e6bbf7ed019f86a0e1daf2b15e10853b4d');

COMMIT;
