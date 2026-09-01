import { readFile } from "node:fs/promises";

type JsonRecord = Record<string, unknown>;

const expectedInternalOrigin = "https://paca.howlearnwood.com";
const expectedDevelopmentAttachmentBucket = "paca-attachments-development";
const expectedInternalAttachmentBucket = "paca-attachments-internal";
const expectedAttachmentCleanupCron = "15 10 * * *";
const expectedRealtimeOutboxCron = "* * * * *";
const expectedDevelopmentRealtimeQueue = "paca-realtime-events-development";
const expectedInternalRealtimeQueue = "paca-realtime-events-internal";
const expectedPartyBindings = new Map([
  ["ProjectParty", "ProjectParty"],
  ["UserParty", "UserParty"],
]);
const expectedRealtimeMigrationTag = "v1-realtime-parties";

function asRecord(value: unknown, label: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value as JsonRecord;
}

function asRecordArray(value: unknown, label: string): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new Error(`${label}_INVALID`);
  }
  return value.map((entry) => asRecord(entry, label));
}

function requiredString(record: JsonRecord, key: string, label: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value) {
    throw new Error(`${label}_${key.toUpperCase()}_INVALID`);
  }
  return value;
}

function hyperdriveId(record: JsonRecord, label: string): string {
  const bindings = asRecordArray(record.hyperdrive, `${label}_HYPERDRIVE`);
  const binding = bindings.find((entry) => entry.binding === "HYPERDRIVE");
  if (!binding) {
    throw new Error(`${label}_HYPERDRIVE_MISSING`);
  }
  return requiredString(binding, "id", `${label}_HYPERDRIVE`);
}

function attachmentBucketName(record: JsonRecord, label: string): string {
  const bindings = asRecordArray(record.r2_buckets, `${label}_R2`);
  const binding = bindings.find((entry) => entry.binding === "TASK_ATTACHMENTS");
  if (!binding) {
    throw new Error(`${label}_TASK_ATTACHMENTS_MISSING`);
  }
  return requiredString(binding, "bucket_name", `${label}_TASK_ATTACHMENTS`);
}

function assertPartyBindings(record: JsonRecord, label: string): void {
  const durableObjects = asRecord(record.durable_objects, `${label}_DURABLE_OBJECTS`);
  const bindings = asRecordArray(durableObjects.bindings, `${label}_DURABLE_OBJECT_BINDINGS`);

  for (const [name, className] of expectedPartyBindings) {
    const binding = bindings.find((entry) => entry.name === name);
    if (!binding || binding.class_name !== className) {
      throw new Error(`${label}_${name.toUpperCase()}_BINDING_INVALID`);
    }
  }
}

function assertRealtimeMigration(record: JsonRecord): void {
  const migrations = asRecordArray(record.migrations, "WRANGLER_MIGRATIONS");
  const migration = migrations.find((entry) => entry.tag === expectedRealtimeMigrationTag);
  if (!migration || !Array.isArray(migration.new_sqlite_classes)) {
    throw new Error("REALTIME_PARTY_MIGRATION_MISSING");
  }

  const classes = new Set(migration.new_sqlite_classes);
  for (const className of expectedPartyBindings.values()) {
    if (!classes.has(className)) {
      throw new Error(`REALTIME_${className.toUpperCase()}_MIGRATION_MISSING`);
    }
  }
}

function assertRealtimeQueue(record: JsonRecord, label: string, expectedQueue: string): void {
  const queues = asRecord(record.queues, `${label}_QUEUES`);
  const producers = asRecordArray(queues.producers, `${label}_QUEUE_PRODUCERS`);
  const consumers = asRecordArray(queues.consumers, `${label}_QUEUE_CONSUMERS`);
  const producer = producers.find((entry) => entry.binding === "REALTIME_EVENTS");
  const consumer = consumers.find((entry) => entry.queue === expectedQueue);
  if (!producer || producer.queue !== expectedQueue) {
    throw new Error(`${label}_REALTIME_QUEUE_PRODUCER_INVALID`);
  }
  if (
    !consumer ||
    consumer.max_batch_size !== 10 ||
    consumer.max_batch_timeout !== 1 ||
    consumer.max_retries !== 5 ||
    consumer.retry_delay !== 5 ||
    consumer.dead_letter_queue !== `${expectedQueue}-dlq`
  ) {
    throw new Error(`${label}_REALTIME_QUEUE_CONSUMER_INVALID`);
  }
}

async function main(): Promise<void> {
  const source = await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8");
  const parsed: unknown = JSON.parse(source);
  const config = asRecord(parsed, "WRANGLER_CONFIG");
  const environments = asRecord(config.env, "WRANGLER_ENVIRONMENTS");
  const internal = asRecord(environments.internal, "WRANGLER_INTERNAL");
  const rootHyperdriveId = hyperdriveId(config, "ROOT");
  const internalHyperdriveId = hyperdriveId(internal, "INTERNAL");
  const developmentAttachmentBucket = attachmentBucketName(config, "ROOT");
  const internalAttachmentBucket = attachmentBucketName(internal, "INTERNAL");
  const usesRootDatabase = internalHyperdriveId === rootHyperdriveId;

  assertPartyBindings(config, "ROOT");
  // Durable Object bindings are non-inheritable Wrangler configuration, so the
  // internal environment must repeat the bindings explicitly.
  assertPartyBindings(internal, "INTERNAL");
  assertRealtimeMigration(config);
  assertRealtimeQueue(config, "ROOT", expectedDevelopmentRealtimeQueue);
  assertRealtimeQueue(internal, "INTERNAL", expectedInternalRealtimeQueue);

  if (usesRootDatabase) {
    throw new Error("INTERNAL_HYPERDRIVE_MUST_NOT_MATCH_ROOT");
  }
  if (developmentAttachmentBucket === internalAttachmentBucket) {
    throw new Error("INTERNAL_ATTACHMENT_BUCKET_MUST_NOT_MATCH_DEVELOPMENT");
  }
  if (developmentAttachmentBucket !== expectedDevelopmentAttachmentBucket) {
    throw new Error("DEVELOPMENT_ATTACHMENT_BUCKET_INVALID");
  }
  if (internalAttachmentBucket !== expectedInternalAttachmentBucket) {
    throw new Error("INTERNAL_ATTACHMENT_BUCKET_INVALID");
  }

  const vars = asRecord(internal.vars, "INTERNAL_VARS");
  const environment = requiredString(vars, "ENVIRONMENT", "INTERNAL_VARS");
  const attachmentCleanupEnabled = requiredString(
    vars,
    "ATTACHMENT_CLEANUP_ENABLED",
    "INTERNAL_VARS",
  );
  const authURL = new URL(requiredString(vars, "BETTER_AUTH_URL", "INTERNAL_VARS"));
  const trustedOrigins = requiredString(vars, "TRUSTED_ORIGINS", "INTERNAL_VARS")
    .split(",")
    .map((origin) => new URL(origin.trim()).origin);
  const routes = asRecordArray(internal.routes, "INTERNAL_ROUTES");
  const triggers = asRecord(internal.triggers, "INTERNAL_TRIGGERS");
  const crons = triggers.crons;
  if (
    attachmentCleanupEnabled !== "true" ||
    !Array.isArray(crons) ||
    crons.length !== 2 ||
    !crons.includes(expectedAttachmentCleanupCron) ||
    !crons.includes(expectedRealtimeOutboxCron)
  ) {
    throw new Error("INTERNAL_ATTACHMENT_CLEANUP_TRIGGER_INVALID");
  }
  const assets = asRecord(config.assets, "WRANGLER_ASSETS");
  const workerFirst = assets.run_worker_first;
  if (!Array.isArray(workerFirst) || !workerFirst.includes("/.well-known/*")) {
    throw new Error("AGENT_DISCOVERY_MUST_RUN_WORKER_FIRST");
  }
  const hasExpectedCustomDomain = routes.some(
    (route) =>
      route.pattern === new URL(expectedInternalOrigin).hostname && route.custom_domain === true,
  );

  if (environment !== "internal") {
    throw new Error("INTERNAL_ENVIRONMENT_NAME_INVALID");
  }
  if (
    internal.workers_dev !== true ||
    !hasExpectedCustomDomain ||
    authURL.origin !== expectedInternalOrigin ||
    trustedOrigins.length !== 1 ||
    trustedOrigins[0] !== expectedInternalOrigin
  ) {
    throw new Error("INTERNAL_AUTH_ORIGIN_INVALID");
  }

  console.log(
    JSON.stringify({
      status: "ok",
      step: "internal-deploy-config",
      databaseMode: "isolated",
      attachmentBucketMode: "isolated",
    }),
  );
}

main().catch((error: unknown) => {
  const code = error instanceof Error ? error.message : "UNKNOWN_ERROR";
  console.error(JSON.stringify({ status: "error", step: "internal-deploy-config", code }));
  process.exitCode = 1;
});
