import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { assertProductionConfiguration } from "../scripts/lib/production-config";

type Config = {
  name: string;
  account_id: string;
  workers_dev: boolean;
  preview_urls?: boolean;
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
  containers: { max_instances: number; image: string; name?: string }[];
  assets: { run_worker_first: string[] };
  triggers: { crons: string[] };
};

function element<T>(values: T[], index: number): T {
  const value = values[index];
  if (value === undefined) throw new Error("CONFIG_FIXTURE_BINDING_MISSING");
  return value;
}

function fixtures() {
  const worker = JSON.parse(
    readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"),
  ) as Config & { env?: unknown };
  const gateway = JSON.parse(
    readFileSync(new URL("../../environment-gateway/wrangler.jsonc", import.meta.url), "utf8"),
  ) as Config & { env?: unknown };
  return { worker, gateway, production: worker, internal: worker };
}

describe("single production deployment", () => {
  it("reuses existing identities with no deployable environment branches", () => {
    const { worker, gateway } = fixtures();
    expect(worker.env).toBeUndefined();
    expect(gateway.env).toBeUndefined();
    expect(worker.hyperdrive[0]?.id).toBe("ec828e1b80664166ab38aa511cfd1f82");
    expect(() => assertProductionConfiguration(worker, gateway)).not.toThrow();
  });
  it.each([
    [
      "second environment",
      ({ worker }) => {
        worker.env = { internal: {} };
      },
    ],
    [
      "public registration label",
      ({ worker }) => {
        worker.vars.ENVIRONMENT = "internal";
      },
    ],
    [
      "foreign account",
      ({ gateway }) => {
        gateway.account_id = "other";
      },
    ],
    [
      "replacement database",
      ({ worker }) => {
        element(worker.hyperdrive, 0).id = "98086061f9064f6c8f815303002c4a88";
      },
    ],
    [
      "database password",
      ({ worker }) => {
        element(worker.hyperdrive, 0).localConnectionString = "postgres://invalid";
      },
    ],
    [
      "preview URL",
      ({ gateway }) => {
        gateway.preview_urls = true;
      },
    ],
    [
      "workers.dev URL",
      ({ worker }) => {
        worker.workers_dev = true;
      },
    ],
    [
      "other domain",
      ({ worker }) => {
        element(worker.routes, 0).pattern = "paca-internal.howlearnwood.com";
      },
    ],
    [
      "foreign auth origin",
      ({ worker }) => {
        worker.vars.TRUSTED_ORIGINS += ",https://example.com";
      },
    ],
    [
      "unbound gateway",
      ({ worker }) => {
        element(worker.services, 0).service = "paca-environment-gateway-production";
      },
    ],
    [
      "replacement bucket",
      ({ worker }) => {
        element(worker.r2_buckets, 0).bucket_name = "paca-attachments-production";
      },
    ],
    [
      "missing coordinator",
      ({ worker }) => {
        worker.durable_objects.bindings.pop();
      },
    ],
    [
      "disabled queue retry",
      ({ worker }) => {
        element(worker.queues.consumers, 0).max_retries = 0;
      },
    ],
    [
      "disabled scheduler",
      ({ worker }) => {
        worker.triggers.crons = [];
      },
    ],
    [
      "replacement Sandbox application",
      ({ gateway }) => {
        element(gateway.containers, 0).name = "new-sandbox";
      },
    ],
    [
      "unbounded sandbox",
      ({ gateway }) => {
        element(gateway.containers, 0).max_instances = 100;
      },
    ],
    [
      "SPA auth boundary",
      ({ worker }) => {
        worker.assets.run_worker_first = ["/health"];
      },
    ],
  ] satisfies [
    string,
    (fixture: ReturnType<typeof fixtures>) => void,
  ][])("rejects %s", (_name, mutate) => {
    const fixture = fixtures();
    mutate(fixture);
    expect(() => assertProductionConfiguration(fixture.worker, fixture.gateway)).toThrow();
  });
});
