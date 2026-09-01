BEGIN;

CREATE TABLE "paca_document" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"title" text DEFAULT 'Untitled' NOT NULL,
	"content" jsonb,
	"content_version" bigint DEFAULT 0 NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_by" text,
	"updated_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "paca_document_content_version_check" CHECK ("paca_document"."content_version" >= 0)
);
--> statement-breakpoint
ALTER TABLE "paca_document" ADD CONSTRAINT "paca_document_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_document" ADD CONSTRAINT "paca_document_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_document" ADD CONSTRAINT "paca_document_updated_by_user_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_document_project_position_idx" ON "paca_document" USING btree ("project_id","position","title");--> statement-breakpoint
CREATE INDEX "paca_document_deleted_idx" ON "paca_document" USING btree ("deleted_at") WHERE "paca_document"."deleted_at" is not null;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION public.paca_document_realtime_trigger() RETURNS trigger
LANGUAGE plpgsql
SET search_path = pg_catalog, public
AS $$
DECLARE
	row_value public.paca_document;
	event_name text;
BEGIN
	row_value := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
	event_name := CASE
		WHEN TG_OP = 'INSERT' THEN 'doc.created'
		WHEN TG_OP = 'DELETE' OR (OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL) THEN 'doc.deleted'
		ELSE 'doc.updated'
	END;
	PERFORM public.paca_enqueue_project_realtime_event(
		event_name,
		row_value.project_id,
		jsonb_build_object(
			'document_id', row_value.id::text,
			'content_version', row_value.content_version
		)
	);
	RETURN row_value;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER paca_document_realtime_outbox
AFTER INSERT OR UPDATE OR DELETE ON public.paca_document
FOR EACH ROW EXECUTE FUNCTION public.paca_document_realtime_trigger();

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0016_busy_changeling', '7fe1a40853b48e376dc1898cdfe78b268061dcf250c047a4d6e0230890da26c3');

COMMIT;
