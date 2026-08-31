BEGIN;

CREATE UNIQUE INDEX "paca_attachment_migration_active_source_uidx" ON "paca_attachment_migration_item" USING btree ("source_attachment_id") WHERE "paca_attachment_migration_item"."status" <> 'rolled_back';

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0014_clear_ultron', '7efb7d8f57c3cdf6dfbb30aaaa902fee50a1bdd746eed9b12c4ffdc4fa6b9e40');

COMMIT;
