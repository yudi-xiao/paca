BEGIN;

CREATE TABLE "paca_branding_upload" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"slot" text NOT NULL,
	"storage_key" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"actual_size" bigint,
	"etag" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"uploaded_by" text,
	"cleanup_claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_branding_upload_storage_key_unique" UNIQUE("storage_key"),
	CONSTRAINT "paca_branding_upload_slot_check" CHECK ("paca_branding_upload"."slot" in ('logo', 'favicon')),
	CONSTRAINT "paca_branding_upload_status_check" CHECK ("paca_branding_upload"."status" in ('pending', 'uploaded', 'active', 'obsolete')),
	CONSTRAINT "paca_branding_upload_declared_size_check" CHECK ("paca_branding_upload"."declared_size" > 0),
	CONSTRAINT "paca_branding_upload_actual_size_check" CHECK ("paca_branding_upload"."actual_size" is null or "paca_branding_upload"."actual_size" > 0)
);
--> statement-breakpoint
CREATE TABLE "paca_workspace_settings" (
	"id" boolean PRIMARY KEY DEFAULT true NOT NULL,
	"logo_upload_id" uuid,
	"favicon_upload_id" uuid,
	"primary_color_light" text,
	"primary_color_dark" text,
	"brand_name" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text,
	CONSTRAINT "paca_workspace_settings_singleton_check" CHECK ("paca_workspace_settings"."id" = true)
);
--> statement-breakpoint
ALTER TABLE "paca_branding_upload" ADD CONSTRAINT "paca_branding_upload_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_workspace_settings" ADD CONSTRAINT "paca_workspace_settings_logo_upload_id_paca_branding_upload_id_fk" FOREIGN KEY ("logo_upload_id") REFERENCES "public"."paca_branding_upload"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_workspace_settings" ADD CONSTRAINT "paca_workspace_settings_favicon_upload_id_paca_branding_upload_id_fk" FOREIGN KEY ("favicon_upload_id") REFERENCES "public"."paca_branding_upload"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_workspace_settings" ADD CONSTRAINT "paca_workspace_settings_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_branding_upload_cleanup_idx" ON "paca_branding_upload" USING btree ("status","cleanup_claimed_at","created_at");--> statement-breakpoint
CREATE INDEX "paca_branding_upload_actor_idx" ON "paca_branding_upload" USING btree ("uploaded_by","created_at");

INSERT INTO "paca_workspace_settings" ("id") VALUES (true);

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0023_worried_paibok', '4e2875527500b076fd6e4eec0a3ccab4b8f5492bb6ab8dcf044a874eadbe039f');

COMMIT;
