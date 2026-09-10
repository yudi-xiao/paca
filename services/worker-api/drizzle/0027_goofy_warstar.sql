BEGIN;

DROP TABLE "paca_attachment_migration_item";
--> statement-breakpoint
INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0027_goofy_warstar', '6c07bee0b0ff6cf45929e93a05923b7a1d41905c7f40dea9fdd41ab91644c272');

COMMIT;
