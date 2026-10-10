import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  assertProductionConfiguration,
  LOCAL_HYPERDRIVE_ID,
} from "../scripts/lib/production-config";

type Config = {
  name: string;
  account_id: string;
  workers_dev: boolean;
  routes: { pattern: string; custom_domain: boolean }[];
  vars: Record<string, string>;
  hyperdrive: { binding: string; id: string; localConnectionString?: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  queues: {
    producers: { binding: string; queue: string }[];
    consumers: { queue: string; dead_letter_queue: string; max_retries: number }[];
  };
  workflows: { binding: string; name: string; script_name?: string }[];
  services: { binding: string; service: string }[];
  durable_objects: { bindings: { name: string; class_name: string; script_name?: string }[] };
  containers: { max_instances: number; image: string }[];
  assets: { run_worker_first: string[] };
  triggers: { crons: string[] };
};

type RootConfig = Config & { env: { production: Config; internal: Config } };

function element<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("CONFIG_FIXTURE_BINDING_MISSING");
  return value;
}

function fixtures() {
  const worker = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as RootConfig;
  const gateway = JSON.parse(
    readFileSync(new URL("../../environment-gateway/wrangler.jsonc", import.meta.url), "utf8"),
  ) as RootConfig;
  return { worker, gateway, production: worker.env.production, internal: worker.env.internal };
}

describe("production deployment isolation", () => {
  it("validates the checked-in candidate without taking either current domain", () => {
    const { worker, gateway } = fixtures();
    expect(worker.hyperdrive[0]?.id).toBe(LOCAL_HYPERDRIVE_ID);
    expect(() => assertProductionConfiguration(worker, gateway, "candidate")).not.toThrow();
    expect(() => assertProductionConfiguration(worker, gateway, "release")).toThrow(
      "RELEASE_ROUTE_INVALID",
    );
  });

  it.each([
    [
      "default remote database",
      ({ worker }) => {
        element(worker.hyperdrive, 0).id = "f2c6d6944f65417785dd49964e0c3238";
      },
    ],
    [
      "production reusing preview database",
      ({ production, internal }) => {
        element(production.hyperdrive, 0).id = element(internal.hyperdrive, 0).id;
      },
    ],
    [
      "production reusing retired broad database role",
      ({ production }) => {
        element(production.hyperdrive, 0).id = "f2c6d6944f65417785dd49964e0c3238";
      },
    ],
    [
      "database password in config",
      ({ production }) => {
        element(production.hyperdrive, 0).localConnectionString = "postgres://invalid";
      },
    ],
    [
      "root public hostname",
      ({ worker }) => {
        worker.workers_dev = true;
      },
    ],
    [
      "production public hostname before acceptance",
      ({ production }) => {
        production.workers_dev = true;
      },
    ],
    [
      "production taking current domain early",
      ({ production }) => {
        production.routes = [{ pattern: "paca.howlearnwood.com", custom_domain: true }];
      },
    ],
    [
      "gateway taking current domain early",
      ({ gateway }) => {
        gateway.env.production.routes = [
          { pattern: "paca-env.howlearnwood.com", custom_domain: true },
        ];
      },
    ],
    [
      "preview attachment bucket",
      ({ production, internal }) => {
        element(production.r2_buckets, 0).bucket_name = element(internal.r2_buckets, 0).bucket_name;
      },
    ],
    [
      "preview snapshot bucket",
      ({ production, internal }) => {
        element(production.r2_buckets, 1).bucket_name = element(internal.r2_buckets, 1).bucket_name;
      },
    ],
    [
      "preview queue producer",
      ({ production, internal }) => {
        element(production.queues.producers, 0).queue = element(internal.queues.producers, 0).queue;
      },
    ],
    [
      "preview dead letter queue",
      ({ production, internal }) => {
        element(production.queues.consumers, 1).dead_letter_queue = element(
          internal.queues.consumers,
          1,
        ).dead_letter_queue;
      },
    ],
    [
      "disabled queue recovery",
      ({ production }) => {
        element(production.queues.consumers, 2).max_retries = 0;
      },
    ],
    [
      "preview workflow",
      ({ production, internal }) => {
        element(production.workflows, 0).name = element(internal.workflows, 0).name;
      },
    ],
    [
      "remote workflow",
      ({ production }) => {
        element(production.workflows, 1).script_name = "paca-worker-api-internal";
      },
    ],
    [
      "preview Durable Object namespace",
      ({ production }) => {
        element(production.durable_objects.bindings, 2).script_name = "paca-worker-api-internal";
      },
    ],
    [
      "missing Agent coordinator",
      ({ production }) => {
        production.durable_objects.bindings.pop();
      },
    ],
    [
      "preview Gateway binding",
      ({ production, internal }) => {
        element(production.services, 0).service = element(internal.services, 0).service;
      },
    ],
    [
      "preview label enabling public signup",
      ({ production }) => {
        production.vars.ENVIRONMENT = "internal";
      },
    ],
    [
      "additional trusted auth origin",
      ({ production }) => {
        production.vars.TRUSTED_ORIGINS += ",https://example.com";
      },
    ],
    [
      "preview Gateway namespace",
      ({ gateway }) => {
        element(gateway.env.production.durable_objects.bindings, 0).script_name =
          "paca-environment-gateway-internal";
      },
    ],
    [
      "unbounded Sandbox capacity",
      ({ gateway }) => {
        element(gateway.env.production.containers, 0).max_instances = 100;
      },
    ],
    [
      "discovery handled by SPA",
      ({ worker }) => {
        worker.assets.run_worker_first = worker.assets.run_worker_first.filter(
          (p) => p !== "/.well-known/*",
        );
      },
    ],
    [
      "disabled outbox scheduler",
      ({ production }) => {
        production.triggers.crons = ["15 10 * * *"];
      },
    ],
  ] satisfies [
    string,
    (fixture: ReturnType<typeof fixtures>) => void,
  ][])("rejects %s", (_name, mutate) => {
    const fixture = fixtures();
    mutate(fixture);
    expect(() =>
      assertProductionConfiguration(fixture.worker, fixture.gateway, "candidate"),
    ).toThrow();
  });

  it("requires all API, auth and Gateway domain changes together for release", () => {
    const { worker, gateway, production, internal } = fixtures();
    production.routes = [{ pattern: "paca.howlearnwood.com", custom_domain: true }];
    gateway.env.production.routes = [{ pattern: "paca-env.howlearnwood.com", custom_domain: true }];
    expect(() => assertProductionConfiguration(worker, gateway, "release")).toThrow(
      "RELEASE_AUTH_ORIGIN_INVALID",
    );
    internal.vars.BETTER_AUTH_URL = internal.vars.TRUSTED_ORIGINS =
      "https://paca-internal.howlearnwood.com";
    internal.routes = [{ pattern: "paca-internal.howlearnwood.com", custom_domain: true }];
    gateway.env.internal.vars.PUBLIC_ORIGIN = "https://paca-env-internal.howlearnwood.com";
    gateway.env.internal.routes = [
      { pattern: "paca-env-internal.howlearnwood.com", custom_domain: true },
    ];
    expect(() => assertProductionConfiguration(worker, gateway, "release")).not.toThrow();
    expect(() => assertProductionConfiguration(worker, gateway, "candidate")).toThrow(
      "RELEASE_ROUTE_INVALID",
    );
  });
});
