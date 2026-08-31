BEGIN;

CREATE TABLE "paca_file" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"storage_key" text NOT NULL,
	"bucket" text NOT NULL,
	"file_name" text NOT NULL,
	"content_type" text NOT NULL,
	"declared_size" bigint NOT NULL,
	"actual_size" bigint,
	"sha256" text,
	"etag" text,
	"upload_status" text DEFAULT 'pending' NOT NULL,
	"multipart_upload_id" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "paca_file_id_project_task_unique" UNIQUE("id","project_id","task_id"),
	CONSTRAINT "paca_file_upload_status_check" CHECK ("paca_file"."upload_status" in ('pending', 'uploaded', 'failed')),
	CONSTRAINT "paca_file_declared_size_check" CHECK ("paca_file"."declared_size" > 0 and "paca_file"."declared_size" <= 536870912),
	CONSTRAINT "paca_file_actual_size_check" CHECK ("paca_file"."actual_size" is null or "paca_file"."actual_size" = "paca_file"."declared_size"),
	CONSTRAINT "paca_file_completed_metadata_check" CHECK (("paca_file"."upload_status" = 'uploaded' and "paca_file"."actual_size" is not null and "paca_file"."sha256" is not null and "paca_file"."etag" is not null and "paca_file"."completed_at" is not null and "paca_file"."multipart_upload_id" is null) or ("paca_file"."upload_status" <> 'uploaded' and "paca_file"."completed_at" is null))
);
--> statement-breakpoint
CREATE TABLE "paca_task_attachment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"file_id" uuid NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "paca_task_attachment_task_file_unique" UNIQUE("task_id","file_id")
);
--> statement-breakpoint
ALTER TABLE "paca_file" ADD CONSTRAINT "paca_file_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_file" ADD CONSTRAINT "paca_file_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_file" ADD CONSTRAINT "paca_file_uploaded_by_user_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_file" ADD CONSTRAINT "paca_file_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD CONSTRAINT "paca_task_attachment_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD CONSTRAINT "paca_task_attachment_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_task_attachment" ADD CONSTRAINT "paca_task_attachment_file_scope_fk" FOREIGN KEY ("file_id","project_id","task_id") REFERENCES "public"."paca_file"("id","project_id","task_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "paca_file_storage_key_uidx" ON "paca_file" USING btree ("storage_key");--> statement-breakpoint
CREATE INDEX "paca_file_project_task_idx" ON "paca_file" USING btree ("project_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_file_pending_idx" ON "paca_file" USING btree ("created_at") WHERE "paca_file"."upload_status" <> 'uploaded';--> statement-breakpoint
CREATE INDEX "paca_task_attachment_task_created_idx" ON "paca_task_attachment" USING btree ("task_id","created_at") WHERE "paca_task_attachment"."deleted_at" is null;--> statement-breakpoint
CREATE INDEX "paca_task_attachment_file_idx" ON "paca_task_attachment" USING btree ("file_id");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0010_talented_scorpion', 'acfe6b684bf774a0fdd2eb0756e3c36bc484f13c34ba628247d56a0e798af0ac');

COMMIT;
