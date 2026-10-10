type RecordValue = Record<string, unknown>;
export type ReleaseStage = "candidate" | "release";

// An unbound local simulator cannot silently use the former main database.
export const LOCAL_HYPERDRIVE_ID = "00000000000000000000000000000000";
const retiredMainHyperdriveId = "f2c6d6944f65417785dd49964e0c3238";
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

function assertBusinessBindings(config: RecordValue, environment: string): string {
  const vars = record(config.vars);
  requireCondition(vars.ENVIRONMENT === environment, "RELEASE_ENVIRONMENT_INVALID");
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
        `paca-${bucket}-${environment}`,
      "RELEASE_BUCKET_ISOLATION_INVALID",
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
    const queue = `paca-${suffix}-${environment}`;
    requireCondition(
      binding(queues.producers, "binding", name).queue === queue,
      "RELEASE_QUEUE_ISOLATION_INVALID",
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
      workflow.name === `paca-${suffix}-${environment}` &&
        workflow.class_name === className &&
        workflow.script_name === undefined,
      "RELEASE_WORKFLOW_ISOLATION_INVALID",
    );
  }
  assertDurableObjects(config, ["ProjectParty", "UserParty", "DocumentParty", "AgentCoordinator"]);
  return hyperdrive.id;
}

export function assertProductionConfiguration(
  workerValue: unknown,
  gatewayValue: unknown,
  stage: ReleaseStage,
): void {
  requireCondition(stage === "candidate" || stage === "release", "RELEASE_STAGE_INVALID");
  const worker = record(workerValue);
  const gateway = record(gatewayValue);
  const environments = record(worker.env);
  const production = record(environments.production);
  const internal = record(environments.internal);
  const gatewayEnvironments = record(gateway.env);
  const productionGateway = record(gatewayEnvironments.production);
  const internalGateway = record(gatewayEnvironments.internal);
  for (const root of [worker, gateway]) {
    requireCondition(root.account_id === accountId, "RELEASE_ACCOUNT_INVALID");
    requireCondition(root.workers_dev === false, "RELEASE_DEFAULT_PUBLIC_ACCESS_FORBIDDEN");
    assertRoutes(root, undefined);
  }
  const rootId = assertBusinessBindings(worker, "development");
  requireCondition(rootId === LOCAL_HYPERDRIVE_ID, "RELEASE_DEVELOPMENT_DATABASE_MUST_BE_LOCAL");
  const productionId = assertBusinessBindings(production, "production");
  const internalId = assertBusinessBindings(internal, "internal");
  requireCondition(
    new Set([rootId, productionId, internalId]).size === 3 &&
      productionId !== retiredMainHyperdriveId &&
      internalId !== retiredMainHyperdriveId,
    "RELEASE_DATABASE_ISOLATION_INVALID",
  );
  requireCondition(
    production.name === "paca-worker-api-production" &&
      internal.name === "paca-worker-api-internal" &&
      productionGateway.name === "paca-environment-gateway-production" &&
      internalGateway.name === "paca-environment-gateway-internal",
    "RELEASE_WORKER_ISOLATION_INVALID",
  );
  requireCondition(
    production.workers_dev === false && productionGateway.workers_dev === false,
    "RELEASE_PRODUCTION_WORKERS_DEV_FORBIDDEN",
  );
  assertOrigin(record(production.vars), productionOrigin);
  assertOrigin(record(productionGateway.vars), productionGatewayOrigin, true);
  assertRoutes(production, stage === "release" ? new URL(productionOrigin).hostname : undefined);
  assertRoutes(
    productionGateway,
    stage === "release" ? new URL(productionGatewayOrigin).hostname : undefined,
  );
  const internalOrigin =
    stage === "candidate" ? productionOrigin : "https://paca-internal.howlearnwood.com";
  const internalGatewayOrigin =
    stage === "candidate" ? productionGatewayOrigin : "https://paca-env-internal.howlearnwood.com";
  assertOrigin(record(internal.vars), internalOrigin);
  assertOrigin(record(internalGateway.vars), internalGatewayOrigin, true);
  assertRoutes(internal, new URL(internalOrigin).hostname);
  assertRoutes(internalGateway, new URL(internalGatewayOrigin).hostname);
  for (const [config, environment] of [
    [production, "production"],
    [internal, "internal"],
  ] as const) {
    requireCondition(
      binding(config.services, "binding", "ENVIRONMENT_GATEWAY").service ===
        `paca-environment-gateway-${environment}`,
      "RELEASE_GATEWAY_BINDING_ISOLATION_INVALID",
    );
    const crons = record(config.triggers).crons;
    requireCondition(
      record(config.vars).ATTACHMENT_CLEANUP_ENABLED === "true" &&
        Array.isArray(crons) &&
        crons.length === 2 &&
        crons.includes("* * * * *") &&
        crons.includes("15 10 * * *"),
      "RELEASE_SCHEDULED_RECOVERY_INVALID",
    );
    const gatewayConfig = environment === "production" ? productionGateway : internalGateway;
    requireCondition(
      record(gatewayConfig.vars).ENVIRONMENT === environment,
      "RELEASE_GATEWAY_ENVIRONMENT_INVALID",
    );
    assertDurableObjects(gatewayConfig, [
      "Sandbox",
      "ConnectionTicketDO",
      "AgentConnectionRegistryDO",
      "UserConnectionRegistryDO",
      "EnvironmentTicketBarrierDO",
    ]);
    const containers = records(gatewayConfig.containers);
    requireCondition(
      containers.length === 1 &&
        containers[0]?.class_name === "Sandbox" &&
        containers[0].image === records(gateway.containers)[0]?.image &&
        containers[0].max_instances === 5 &&
        containers[0].instance_type === "lite",
      "RELEASE_SANDBOX_ISOLATION_INVALID",
    );
  }
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
