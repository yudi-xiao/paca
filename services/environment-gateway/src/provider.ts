import { getSandbox, proxyTerminal } from "@cloudflare/sandbox";

import type { TicketClaims } from "./protocol";

export type EnvironmentStatus = {
  environmentId: string;
  processes: Array<{
    id: string;
    pid?: number;
    status: string;
    startTime: string;
    endTime?: string;
    exitCode?: number;
    sessionId?: string;
  }>;
};

export interface EnvironmentProvider {
  supports(claims: TicketClaims): boolean;
  status(claims: TicketClaims): Promise<EnvironmentStatus>;
  terminal(claims: TicketClaims, sessionId: string, request: Request): Promise<Response>;
  terminate(
    input: { backend: TicketClaims["backend"]; reference: string },
    sessionId: string,
  ): Promise<void>;
}

const SANDBOX_ID = /^[a-z0-9][a-z0-9-]{0,62}$/u;

export class CloudflareSandboxProvider implements EnvironmentProvider {
  constructor(private readonly env: Pick<Env, "SANDBOXES">) {}

  supports(claims: TicketClaims): boolean {
    return claims.backend === "cloudflare-sandbox" && SANDBOX_ID.test(claims.reference);
  }

  private sandbox(claims: TicketClaims) {
    return getSandbox(this.env.SANDBOXES, claims.reference, {
      sleepAfter: "10m",
      labels: {
        environmentId: claims.environmentId,
        projectId: claims.projectId,
        workload: "paca-environment",
      },
    });
  }

  async status(claims: TicketClaims): Promise<EnvironmentStatus> {
    const processes = await this.sandbox(claims).listProcesses();
    return {
      environmentId: claims.environmentId,
      processes: processes.slice(0, 1000).map((process) => ({
        id: process.id,
        ...(process.pid === undefined ? {} : { pid: process.pid }),
        status: process.status,
        startTime: process.startTime.toISOString(),
        ...(process.endTime === undefined ? {} : { endTime: process.endTime.toISOString() }),
        ...(process.exitCode === undefined ? {} : { exitCode: process.exitCode }),
        ...(process.sessionId === undefined ? {} : { sessionId: process.sessionId }),
      })),
    };
  }

  async terminal(claims: TicketClaims, sessionId: string, request: Request): Promise<Response> {
    return proxyTerminal(this.sandbox(claims), sessionId, request, {
      cols: 120,
      rows: 30,
    });
  }

  async terminate(
    input: { backend: TicketClaims["backend"]; reference: string },
    sessionId: string,
  ): Promise<void> {
    if (input.backend !== "cloudflare-sandbox" || !SANDBOX_ID.test(input.reference)) {
      throw new Error("GATEWAY_PROVIDER_UNAVAILABLE");
    }
    const result = await getSandbox(this.env.SANDBOXES, input.reference, {
      sleepAfter: "10m",
    }).deleteSession(sessionId);
    if (!result.success) throw new Error("GATEWAY_SESSION_TERMINATION_FAILED");
  }
}
