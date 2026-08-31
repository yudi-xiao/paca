BEGIN;

CREATE TABLE "paca_organization_member_role" (
	"member_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"organization_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_organization_member_role_member_id_role_id_pk" PRIMARY KEY("member_id","role_id")
);
--> statement-breakpoint
CREATE TABLE "paca_organization_role_permission" (
	"role_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_organization_role_permission_role_id_resource_action_pk" PRIMARY KEY("role_id","resource","action")
);
--> statement-breakpoint
CREATE TABLE "paca_organization_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_organization_role_id_organization_unique" UNIQUE("id","organization_id")
);
--> statement-breakpoint
CREATE TABLE "paca_system_role_permission" (
	"role_id" uuid NOT NULL,
	"resource" text NOT NULL,
	"action" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_system_role_permission_role_id_resource_action_pk" PRIMARY KEY("role_id","resource","action")
);
--> statement-breakpoint
CREATE TABLE "paca_system_role" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_built_in" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "paca_user_system_role" (
	"user_id" text NOT NULL,
	"role_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_user_system_role_user_id_role_id_pk" PRIMARY KEY("user_id","role_id")
);
--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_id_organization_unique" UNIQUE("id","organization_id");--> statement-breakpoint
ALTER TABLE "paca_organization_member_role" ADD CONSTRAINT "paca_organization_member_role_member_organization_fk" FOREIGN KEY ("member_id","organization_id") REFERENCES "public"."member"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_organization_member_role" ADD CONSTRAINT "paca_organization_member_role_role_organization_fk" FOREIGN KEY ("role_id","organization_id") REFERENCES "public"."paca_organization_role"("id","organization_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_organization_role_permission" ADD CONSTRAINT "paca_organization_role_permission_role_id_paca_organization_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."paca_organization_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_organization_role" ADD CONSTRAINT "paca_organization_role_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_system_role_permission" ADD CONSTRAINT "paca_system_role_permission_role_id_paca_system_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."paca_system_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_user_system_role" ADD CONSTRAINT "paca_user_system_role_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "paca_user_system_role" ADD CONSTRAINT "paca_user_system_role_role_id_paca_system_role_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."paca_system_role"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "paca_organization_member_role_organization_idx" ON "paca_organization_member_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "paca_organization_role_permission_lookup_idx" ON "paca_organization_role_permission" USING btree ("resource","action");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_organization_role_organization_name_uidx" ON "paca_organization_role" USING btree ("organization_id","name");--> statement-breakpoint
CREATE INDEX "paca_organization_role_organization_idx" ON "paca_organization_role" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "paca_system_role_permission_lookup_idx" ON "paca_system_role_permission" USING btree ("resource","action");--> statement-breakpoint
CREATE UNIQUE INDEX "paca_system_role_name_uidx" ON "paca_system_role" USING btree ("name");--> statement-breakpoint
CREATE INDEX "paca_user_system_role_role_idx" ON "paca_user_system_role" USING btree ("role_id");
--> statement-breakpoint
INSERT INTO "organization" ("id", "name", "slug", "created_at")
VALUES ('paca-default', 'Paca', 'paca', now())
ON CONFLICT ("id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "paca_system_role" ("id", "name", "description", "is_built_in") VALUES
	('00000000-0000-4000-8000-000000000001', 'SUPER_ADMIN', 'Paca instance super administrator', true),
	('00000000-0000-4000-8000-000000000002', 'ADMIN', 'Paca instance administrator', true),
	('00000000-0000-4000-8000-000000000003', 'USER', 'Paca instance user', true)
ON CONFLICT ("name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "paca_system_role_permission" ("role_id", "resource", "action") VALUES
	('00000000-0000-4000-8000-000000000001', '*', '*'),
	('00000000-0000-4000-8000-000000000002', 'users', '*'),
	('00000000-0000-4000-8000-000000000002', 'globalRoles', '*'),
	('00000000-0000-4000-8000-000000000002', 'projects', '*'),
	('00000000-0000-4000-8000-000000000002', 'settings', 'write'),
	('00000000-0000-4000-8000-000000000003', 'users', 'read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
INSERT INTO "paca_organization_role" (
	"id", "organization_id", "name", "description", "is_built_in"
) VALUES
	('00000000-0000-4000-8000-000000000101', 'paca-default', 'OWNER', 'Organization owner', true),
	('00000000-0000-4000-8000-000000000102', 'paca-default', 'MEMBER', 'Organization member', true)
ON CONFLICT ("organization_id", "name") DO NOTHING;
--> statement-breakpoint
INSERT INTO "paca_organization_role_permission" ("role_id", "resource", "action") VALUES
	('00000000-0000-4000-8000-000000000101', 'projects', '*'),
	('00000000-0000-4000-8000-000000000101', 'agents', '*'),
	('00000000-0000-4000-8000-000000000101', 'workflows', '*'),
	('00000000-0000-4000-8000-000000000102', 'projects', 'read')
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH ranked_users AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS ordinal
	FROM "user"
)
INSERT INTO "paca_user_system_role" ("user_id", "role_id")
SELECT
	"id",
	CASE
		WHEN ordinal = 1 THEN '00000000-0000-4000-8000-000000000001'::uuid
		ELSE '00000000-0000-4000-8000-000000000003'::uuid
	END
FROM ranked_users
ON CONFLICT DO NOTHING;
--> statement-breakpoint
WITH ranked_users AS (
	SELECT "id", row_number() OVER (ORDER BY "created_at", "id") AS ordinal
	FROM "user"
)
INSERT INTO "member" ("id", "organization_id", "user_id", "role", "created_at")
SELECT
	gen_random_uuid()::text,
	'paca-default',
	"id",
	CASE WHEN ordinal = 1 THEN 'owner' ELSE 'member' END,
	now()
FROM ranked_users
ON CONFLICT ("organization_id", "user_id") DO NOTHING;
--> statement-breakpoint
INSERT INTO "paca_organization_member_role" ("member_id", "role_id", "organization_id")
SELECT
	m."id",
	CASE
		WHEN sr."name" = 'SUPER_ADMIN' THEN '00000000-0000-4000-8000-000000000101'::uuid
		ELSE '00000000-0000-4000-8000-000000000102'::uuid
	END,
	'paca-default'
FROM "member" m
INNER JOIN "paca_user_system_role" usr ON usr."user_id" = m."user_id"
INNER JOIN "paca_system_role" sr ON sr."id" = usr."role_id"
WHERE m."organization_id" = 'paca-default'
ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE "session"
SET "active_organization_id" = 'paca-default'
WHERE "active_organization_id" IS NULL;
--> statement-breakpoint
INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0001_lame_the_enforcers', '10f97fedcd83b5be1c4602f46b1ba340179e2cfab76b0df4d0df2e1959bdf084');

COMMIT;
