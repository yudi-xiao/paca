BEGIN;

CREATE TABLE "paca_github_delivery" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid NOT NULL,
	"lease_id" uuid NOT NULL,
	"repository_id" bigint NOT NULL,
	"policy_version" integer NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"pull_number" bigint NOT NULL,
	"head_sha" text NOT NULL,
	"state" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"accepted_by" text,
	"accepted_at" timestamp with time zone,
	"requested_changes_by" text,
	"requested_changes_at" timestamp with time zone,
	"review_note" text DEFAULT '' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_github_delivery_task_id_unique" UNIQUE("task_id"),
	CONSTRAINT "paca_github_delivery_lease_id_unique" UNIQUE("lease_id"),
	CONSTRAINT "paca_github_delivery_version_check" CHECK ("paca_github_delivery"."version" > 0 and "paca_github_delivery"."policy_version" > 0),
	CONSTRAINT "paca_github_delivery_reference_check" CHECK ("paca_github_delivery"."pull_number" between 1 and 9007199254740991 and "paca_github_delivery"."head_sha" ~ '^[a-f0-9]{40}$'),
	CONSTRAINT "paca_github_delivery_state_check" CHECK ("paca_github_delivery"."state" in ('accepted', 'awaiting_acceptance', 'waiting', 'needs_changes', 'stale', 'unavailable')),
	CONSTRAINT "paca_github_delivery_acceptance_check" CHECK (("paca_github_delivery"."state" = 'accepted' and "paca_github_delivery"."accepted_by" is not null and "paca_github_delivery"."accepted_at" is not null) or ("paca_github_delivery"."state" <> 'accepted' and "paca_github_delivery"."accepted_by" is null and "paca_github_delivery"."accepted_at" is null)),
	CONSTRAINT "paca_github_delivery_changes_check" CHECK (("paca_github_delivery"."requested_changes_by" is null and "paca_github_delivery"."requested_changes_at" is null) or ("paca_github_delivery"."state" = 'needs_changes' and "paca_github_delivery"."requested_changes_by" is not null and "paca_github_delivery"."requested_changes_at" is not null)),
	CONSTRAINT "paca_github_delivery_review_note_check" CHECK (length("paca_github_delivery"."review_note") <= 2000)
);
--> statement-breakpoint
CREATE TABLE "paca_github_delivery_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"project_id" uuid NOT NULL,
	"task_id" uuid,
	"request_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"actor_id" text NOT NULL,
	"action" text NOT NULL,
	"detail" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_github_delivery_audit_request_unique" UNIQUE("request_id"),
	CONSTRAINT "paca_github_delivery_audit_action_check" CHECK ("paca_github_delivery_audit"."action" in ('configure', 'submit', 'refresh', 'accept', 'request_changes'))
);
--> statement-breakpoint
CREATE TABLE "paca_github_repository" (
	"project_id" uuid PRIMARY KEY NOT NULL,
	"repository_id" bigint NOT NULL,
	"installation_id" bigint NOT NULL,
	"policy" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_github_repository_ids_check" CHECK ("paca_github_repository"."repository_id" between 1 and 9007199254740991 and "paca_github_repository"."installation_id" between 1 and 9007199254740991),
	CONSTRAINT "paca_github_repository_version_check" CHECK ("paca_github_repository"."version" > 0),
	CONSTRAINT "paca_github_repository_status_check" CHECK ("paca_github_repository"."status" in ('active', 'revoked')),
	CONSTRAINT "paca_github_repository_policy_check" CHECK (jsonb_typeof("paca_github_repository"."policy") = 'object')
);
--> statement-breakpoint
ALTER TABLE "paca_github_delivery" ADD CONSTRAINT "paca_github_delivery_project_id_paca_github_repository_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_github_repository"("project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_github_delivery" ADD CONSTRAINT "paca_github_delivery_lease_id_paca_agent_task_lease_id_fk" FOREIGN KEY ("lease_id") REFERENCES "public"."paca_agent_task_lease"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_github_delivery" ADD CONSTRAINT "paca_github_delivery_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_github_delivery_audit" ADD CONSTRAINT "paca_github_delivery_audit_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_github_repository" ADD CONSTRAINT "paca_github_repository_project_id_paca_project_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."paca_project"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_github_delivery_pr_idx" ON "paca_github_delivery" USING btree ("repository_id","pull_number");--> statement-breakpoint
CREATE INDEX "paca_github_delivery_commit_idx" ON "paca_github_delivery" USING btree ("repository_id","head_sha");--> statement-breakpoint
CREATE INDEX "paca_github_delivery_audit_task_idx" ON "paca_github_delivery_audit" USING btree ("project_id","task_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_github_repository_installation_idx" ON "paca_github_repository" USING btree ("installation_id","repository_id");

INSERT INTO paca_schema_migration (id, checksum) VALUES ('0038_clammy_yellowjacket', 'ea95f9298c869e91cc089fc29462502daa82d2905b1da67b4f3581761ba432e1');

COMMIT;
