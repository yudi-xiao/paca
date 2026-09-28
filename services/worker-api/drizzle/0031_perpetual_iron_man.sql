BEGIN;

CREATE TABLE "paca_task_mutation_idempotency" (
	"task_id" uuid NOT NULL,
	"project_id" uuid NOT NULL,
	"operation_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "paca_task_mutation_idempotency_task_id_operation_key_pk" PRIMARY KEY("task_id","operation_key"),
	CONSTRAINT "paca_task_mutation_idempotency_key_check" CHECK (length("paca_task_mutation_idempotency"."operation_key") between 1 and 255)
);
--> statement-breakpoint
ALTER TABLE "paca_task_mutation_idempotency" ADD CONSTRAINT "paca_task_mutation_idempotency_task_project_fk" FOREIGN KEY ("task_id","project_id") REFERENCES "public"."paca_task"("id","project_id") ON DELETE cascade ON UPDATE no action;

INSERT INTO "paca_schema_migration" ("id", "checksum")
VALUES ('0031_perpetual_iron_man', '9566e193d751289e6c0b44a3c7e83e09d0c48e2db5f384ea1c7327342e270ee4');

COMMIT;
