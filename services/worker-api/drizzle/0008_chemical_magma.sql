BEGIN;

CREATE TABLE "paca_agent_auth_audit" (
	"id" text PRIMARY KEY NOT NULL,
	"event_type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"agent_id" text,
	"host_id" text,
	"target_type" text,
	"target_id" text,
	"capability" text,
	"execution_status" text,
	"duration_ms" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paca_auth_secondary_storage" (
	"key" text PRIMARY KEY NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"host_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"mode" text DEFAULT 'delegated' NOT NULL,
	"public_key" text NOT NULL,
	"kid" text,
	"jwks_url" text,
	"last_used_at" timestamp,
	"activated_at" timestamp,
	"expires_at" timestamp,
	"metadata" text,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_capability_grant" (
	"id" text PRIMARY KEY NOT NULL,
	"agent_id" text NOT NULL,
	"capability" text NOT NULL,
	"denied_by" text,
	"granted_by" text,
	"expires_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"reason" text,
	"constraints" text
);
--> statement-breakpoint
CREATE TABLE "agent_host" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text,
	"user_id" text,
	"default_capabilities" text,
	"public_key" text,
	"kid" text,
	"jwks_url" text,
	"enrollment_token_hash" text,
	"enrollment_token_expires_at" timestamp,
	"status" text DEFAULT 'active' NOT NULL,
	"activated_at" timestamp,
	"expires_at" timestamp,
	"last_used_at" timestamp,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "approval_request" (
	"id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"agent_id" text,
	"host_id" text,
	"user_id" text,
	"capabilities" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_code_hash" text,
	"login_hint" text,
	"binding_message" text,
	"client_notification_token" text,
	"client_notification_endpoint" text,
	"delivery_mode" text,
	"interval" integer NOT NULL,
	"last_polled_at" timestamp,
	"expires_at" timestamp NOT NULL,
	"created_at" timestamp NOT NULL,
	"updated_at" timestamp NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent" ADD CONSTRAINT "agent_host_id_agent_host_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_host"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grant" ADD CONSTRAINT "agent_capability_grant_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grant" ADD CONSTRAINT "agent_capability_grant_denied_by_user_id_fk" FOREIGN KEY ("denied_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_capability_grant" ADD CONSTRAINT "agent_capability_grant_granted_by_user_id_fk" FOREIGN KEY ("granted_by") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_host" ADD CONSTRAINT "agent_host_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_agent_id_agent_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agent"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_host_id_agent_host_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."agent_host"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "approval_request" ADD CONSTRAINT "approval_request_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_agent_auth_audit_created_idx" ON "paca_agent_auth_audit" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "paca_agent_auth_audit_agent_created_idx" ON "paca_agent_auth_audit" USING btree ("agent_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_agent_auth_audit_actor_created_idx" ON "paca_agent_auth_audit" USING btree ("actor_id","created_at");--> statement-breakpoint
CREATE INDEX "paca_auth_secondary_storage_expiry_idx" ON "paca_auth_secondary_storage" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "agent_userId_idx" ON "agent" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_hostId_idx" ON "agent" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "agent_status_idx" ON "agent" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_kid_idx" ON "agent" USING btree ("kid");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_agentId_idx" ON "agent_capability_grant" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_capability_idx" ON "agent_capability_grant" USING btree ("capability");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_grantedBy_idx" ON "agent_capability_grant" USING btree ("granted_by");--> statement-breakpoint
CREATE INDEX "agent_capability_grant_status_idx" ON "agent_capability_grant" USING btree ("status");--> statement-breakpoint
CREATE INDEX "agent_host_userId_idx" ON "agent_host" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "agent_host_kid_idx" ON "agent_host" USING btree ("kid");--> statement-breakpoint
CREATE INDEX "agent_host_enrollmentTokenHash_idx" ON "agent_host" USING btree ("enrollment_token_hash");--> statement-breakpoint
CREATE INDEX "agent_host_status_idx" ON "agent_host" USING btree ("status");--> statement-breakpoint
CREATE INDEX "approval_request_agentId_idx" ON "approval_request" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "approval_request_hostId_idx" ON "approval_request" USING btree ("host_id");--> statement-breakpoint
CREATE INDEX "approval_request_userId_idx" ON "approval_request" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "approval_request_status_idx" ON "approval_request" USING btree ("status");

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0008_chemical_magma', '38912cd19a073f22330c20d054016cdcf9f538d8fc24085986653d0b7bba7dd0');

COMMIT;
