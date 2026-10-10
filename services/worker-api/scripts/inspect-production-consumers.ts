import * as z from "zod";
import { cloudflareOperator, deployedHyperdriveConsumers } from "./lib/cloudflare-operator";

try {
  const request = await cloudflareOperator();
  const consumers = await deployedHyperdriveConsumers(request, [
    "f2c6d6944f65417785dd49964e0c3238",
    "98086061f9064f6c8f815303002c4a88",
  ]);
  const domains = z
    .array(z.object({ hostname: z.string(), service: z.string() }))
    .parse(await request("/workers/domains"));
  const pacaDomains = domains.filter((domain) => domain.hostname.startsWith("paca"));
  console.log(
    JSON.stringify({
      status: "ok",
      step: "production-consumer-inventory",
      consumers,
      domains: pacaDomains,
    }),
  );
} catch {
  console.error(JSON.stringify({ status: "error", code: "PRODUCTION_CONSUMER_INVENTORY_FAILED" }));
  process.exitCode = 1;
}
