BEGIN;

CREATE TABLE "paca_github_webhook_receipt" (
	"delivery_id" uuid PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"event" text NOT NULL,
	"installation_id" bigint NOT NULL,
	"repository_id" bigint,
	"affected" integer DEFAULT 0 NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_github_webhook_receipt_digest_check" CHECK ("paca_github_webhook_receipt"."digest" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "paca_github_webhook_receipt_affected_check" CHECK ("paca_github_webhook_receipt"."affected" >= 0)
);
--> statement-breakpoint
CREATE INDEX "paca_github_webhook_receipt_received_idx" ON "paca_github_webhook_receipt" USING btree ("received_at");

INSERT INTO paca_schema_migration (id, checksum) VALUES ('0039_jittery_lionheart', '0de74912538d76d7afbb24bb96e67debb076bf8e926c18117e16a619e6acdf7b');

COMMIT;
