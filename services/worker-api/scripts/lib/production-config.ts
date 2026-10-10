type RecordValue = Record<string, unknown>;

const accountId = "25f556b8c06e910fb3115a6c47c25bf9";
const productionOrigin = "https://paca.howlearnwood.com";
const productionGatewayOrigin = "https://paca-env.howlearnwood.com";

function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("RELEASE_CONFIGURATION_INVALID");
  }
  return value as RecordValue;
}

function records(value: unknown): RecordValue[] {
  if (!Array.isArray(value)) throw new Error("RELEASE_BINDINGS_INVALID");
  return value.map(record);
}

function requireCondition(condition: boolean, code: string): asserts condition {
  if (!condition) throw new Error(code);
}

function binding(value: unknown, key: string, name: string): RecordValue {
  const matches = records(value).filter((item) => item[key] === name);
  requireCondition(matches.length === 1, `RELEASE_${name.toUpperCase()}_BINDING_INVALID`);
  return matches[0] as RecordValue;
}

function assertOrigin(vars: RecordValue, origin: string, gateway = false): void {
  if (gateway) {
    requireCondition(vars.PUBLIC_ORIGIN === origin, "RELEASE_GATEWAY_ORIGIN_INVALID");
  } else {
    requireCondition(
      vars.BETTER_AUTH_URL === origin && vars.TRUSTED_ORIGINS === origin,
      "RELEASE_AUTH_ORIGIN_INVALID",
    );
  }
}

function assertRoutes(config: RecordValue, host: string | undefined): void {
  const routes = records(config.routes);
  requireCondition(
    host === undefined
      ? routes.length === 0
      : routes.length === 1 && routes[0]?.pattern === host && routes[0]?.custom_domain === true,
    "RELEASE_ROUTE_INVALID",
  );
}

function assertDurableObjects(config: RecordValue, classes: string[]): void {
  const bindings = records(record(config.durable_objects).bindings);
  requireCondition(bindings.length === classes.length, "RELEASE_DO_BINDINGS_INVALID");
  const gatewayNames: Record<string, string> = {
    Sandbox: "SANDBOXES",
    ConnectionTicketDO: "CONNECTION_TICKETS",
    AgentConnectionRegistryDO: "AGENT_CONNECTIONS",
    UserConnectionRegistryDO: "USER_CONNECTIONS",
    EnvironmentTicketBarrierDO: "ENVIRONMENT_TICKET_BARRIERS",
  };
  for (const className of classes) {
    const matches = bindings.filter((item) => item.class_name === className);
    requireCondition(
      matches.length === 1 &&
        matches[0]?.name === (gatewayNames[className] ?? className) &&
        matches[0].script_name === undefined &&
        matches[0].environment === undefined,
      "RELEASE_DO_MUST_BELONG_TO_OWN_WORKER",
    );
  }
}

function assertBusinessBindings(config: RecordValue): void {
  // Stable resource names preserve existing data, DO state, and credentials.
  const stableSuffix = "internal";
  const vars = record(config.vars);
  requireCondition(vars.ENVIRONMENT === "prod", "RELEASE_ENVIRONMENT_INVALID");
  const hyperdrive = binding(config.hyperdrive, "binding", "HYPERDRIVE");
  requireCondition(
    records(config.hyperdrive).length === 1 &&
      records(config.r2_buckets).length === 2 &&
      records(config.workflows).length === 2,
    "RELEASE_UNEXPECTED_RESOURCE_BINDING",
  );
  requireCondition(
    typeof hyperdrive.id === "string" && /^[a-f0-9]{32}$/u.test(hyperdrive.id),
    "RELEASE_HYPERDRIVE_ID_INVALID",
  );
  requireCondition(
    hyperdrive.localConnectionString === undefined,
    "RELEASE_DATABASE_SECRET_IN_CONFIG",
  );
  for (const [name, bucket] of [
    ["TASK_ATTACHMENTS", "attachments"],
    ["DOCUMENT_SNAPSHOTS", "document-snapshots"],
  ]) {
    requireCondition(
      binding(config.r2_buckets, "binding", name as string).bucket_name ===
        `paca-${bucket}-${stableSuffix}`,
      "RELEASE_BUCKET_INVALID",
    );
  }
  const queues = record(config.queues);
  requireCondition(
    records(queues.producers).length === 3 && records(queues.consumers).length === 3,
    "RELEASE_QUEUE_BINDINGS_INVALID",
  );
  for (const [name, suffix, batch, timeout] of [
    ["REALTIME_EVENTS", "realtime-events", 10, 1],
    ["DOCUMENT_MATERIALIZATION", "document-materialization", 5, 2],
    ["AUTOMATION_EVENTS", "automation-events", 10, 2],
  ] as const) {
    const queue = `paca-${suffix}-${stableSuffix}`;
    requireCondition(
      binding(queues.producers, "binding", name).queue === queue,
      "RELEASE_QUEUE_INVALID",
    );
    const consumer = binding(queues.consumers, "queue", queue);
    requireCondition(
      consumer.dead_letter_queue === `${queue}-dlq` &&
        consumer.max_batch_size === batch &&
        consumer.max_batch_timeout === timeout &&
        consumer.max_retries === 5 &&
        consumer.retry_delay === 5,
      "RELEASE_QUEUE_RECOVERY_INVALID",
    );
  }
  for (const [name, suffix, className] of [
    ["DOCUMENT_AGENT_WORKFLOW", "document-agent", "DocumentAgentWorkflow"],
    ["AUTOMATION_WORKFLOW", "automation", "AutomationWorkflow"],
  ]) {
    const workflow = binding(config.workflows, "binding", name as string);
    requireCondition(
      workflow.name === `paca-${suffix}-${stableSuffix}` &&
        workflow.class_name === className &&
        workflow.script_name === undefined,
      "RELEASE_WORKFLOW_INVALID",
    );
  }
  assertDurableObjects(config, ["ProjectParty", "UserParty", "DocumentParty", "AgentCoordinator"]);
  requireCondition(
    hyperdrive.id === "ec828e1b80664166ab38aa511cfd1f82",
    "RELEASE_HYPERDRIVE_INVALID",
  );
}

export function assertProductionConfiguration(workerValue: unknown, gatewayValue: unknown): void {
  const worker = record(workerValue);
  const gateway = record(gatewayValue);
  for (const config of [worker, gateway]) {
    requireCondition(config.env === undefined, "RELEASE_MULTIPLE_ENVIRONMENTS_FORBIDDEN");
    requireCondition(config.account_id === accountId, "RELEASE_ACCOUNT_INVALID");
    requireCondition(config.workers_dev === false, "RELEASE_WORKERS_DEV_FORBIDDEN");
    requireCondition(config.preview_urls === false, "RELEASE_PREVIEW_ACCESS_FORBIDDEN");
    requireCondition(record(config.vars).ENVIRONMENT === "prod", "RELEASE_ENVIRONMENT_INVALID");
  }
  requireCondition(
    worker.name === "paca-worker-api-internal" &&
      gateway.name === "paca-environment-gateway-internal",
    "RELEASE_EXISTING_WORKER_REQUIRED",
  );
  assertBusinessBindings(worker);
  assertOrigin(record(worker.vars), productionOrigin);
  assertOrigin(record(gateway.vars), productionGatewayOrigin, true);
  assertRoutes(worker, new URL(productionOrigin).hostname);
  assertRoutes(gateway, new URL(productionGatewayOrigin).hostname);
  requireCondition(
    binding(worker.services, "binding", "ENVIRONMENT_GATEWAY").service === gateway.name,
    "RELEASE_GATEWAY_BINDING_INVALID",
  );
  const crons = record(worker.triggers).crons;
  requireCondition(
    record(worker.vars).ATTACHMENT_CLEANUP_ENABLED === "true" &&
      Array.isArray(crons) &&
      crons.length === 2 &&
      crons.includes("* * * * *") &&
      crons.includes("15 10 * * *"),
    "RELEASE_SCHEDULED_RECOVERY_INVALID",
  );
  assertDurableObjects(gateway, [
    "Sandbox",
    "ConnectionTicketDO",
    "AgentConnectionRegistryDO",
    "UserConnectionRegistryDO",
    "EnvironmentTicketBarrierDO",
  ]);
  const containers = records(gateway.containers);
  requireCondition(
    containers.length === 1 &&
      containers[0]?.class_name === "Sandbox" &&
      containers[0].name === "paca-environment-gateway-internal-sandbox-internal" &&
      containers[0].max_instances === 5 &&
      containers[0].instance_type === "lite" &&
      containers[0].image ===
        "docker.io/cloudflare/sandbox@sha256:4a56a37a3cfd9b38d65bb4b5d0b341e6490a3a4c0226274ae4c1cca4948e85fe",
    "RELEASE_SANDBOX_CONFIGURATION_INVALID",
  );
  const assets = record(worker.assets);
  const paths = assets.run_worker_first;
  requireCondition(
    assets.binding === "ASSETS" &&
      assets.not_found_handling === "single-page-application" &&
      Array.isArray(paths) &&
      ["/api/*", "/.well-known/*", "/health", "/internal/*", "/ws/*"].every((path) =>
        paths.includes(path),
      ),
    "RELEASE_SAME_ORIGIN_BOUNDARY_INVALID",
  );
}
