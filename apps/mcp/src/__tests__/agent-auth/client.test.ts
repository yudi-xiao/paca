import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	AgentAuthClient,
	AgentAuthClientError,
	createAgentHeartbeatReport,
	loadAgentAuthConfig,
} from "../../agent-auth/client.js";

const tempDirectories: string[] = [];

function configJson() {
	const pair = generateKeyPairSync("ed25519");
	const publicKey = pair.publicKey.export({ format: "jwk" });
	const privateKey = pair.privateKey.export({ format: "jwk" });
	return {
		config: {
			version: 1,
			providerOrigin: "https://paca.example.com",
			issuer: "https://paca.example.com/api/auth",
			defaultLocation: "https://paca.example.com/api/auth/capability/execute",
			hostId: "host-1",
			agentId: "agent-1",
			agentName: "Codex",
			keyAlgorithm: "Ed25519",
			publicKey,
			privateKey,
			capabilities: ["project.read", "task.execute"],
			grantRequests: [
				{
					capability: "project.read",
					constraints: {
						organizationId: "org-1",
						projectId: "11111111-1111-4111-8111-111111111111",
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
				{
					capability: "task.execute",
					constraints: {
						organizationId: "org-1",
						projectId: "11111111-1111-4111-8111-111111111111",
						validUntil: "2099-01-01T00:00:00.000Z",
					},
				},
			],
			registeredAt: "2026-09-01T00:00:00.000Z",
		},
		publicKey,
	};
}

async function writeConfig(mode = 0o600) {
	const directory = await mkdtemp(join(tmpdir(), "paca-mcp-agent-auth-"));
	tempDirectories.push(directory);
	const path = join(directory, "agent.json");
	const fixture = configJson();
	await writeFile(path, JSON.stringify(fixture.config), { mode });
	await chmod(path, mode);
	return { path, ...fixture };
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(
		tempDirectories
			.splice(0)
			.map((path) => rm(path, { recursive: true, force: true })),
	);
});

describe("Agent Auth MCP client", () => {
	it("loads only a private regular 0600 identity file", async () => {
		const fixture = await writeConfig();
		await expect(loadAgentAuthConfig(fixture.path)).resolves.toMatchObject({
			hostId: "host-1",
			agentId: "agent-1",
			providerOrigin: "https://paca.example.com",
		});

		await chmod(fixture.path, 0o644);
		await expect(loadAgentAuthConfig(fixture.path)).rejects.toMatchObject({
			code: "PACA_AGENT_CONFIG_PERMISSIONS_INVALID",
		});
	});

	it("rejects a symlink before reading private key material", async () => {
		const fixture = await writeConfig();
		const link = join(fixture.path, "..", "linked-agent.json");
		await symlink(fixture.path, link);
		await expect(loadAgentAuthConfig(link)).rejects.toMatchObject({
			code: "PACA_AGENT_CONFIG_PERMISSIONS_INVALID",
		});
	});

	it("signs a fresh, short-lived Agent JWT for every request", async () => {
		const fixture = await writeConfig();
		const config = await loadAgentAuthConfig(fixture.path);
		const tokens: string[] = [];
		const request = vi.fn(
			async (_input: string | URL | Request, init?: RequestInit) => {
				tokens.push(
					new Headers(init?.headers)
						.get("authorization")
						?.replace("Bearer ", "") ?? "",
				);
				return new Response(JSON.stringify({ data: { id: "project-1" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		);
		const client = new AgentAuthClient(
			config,
			request as typeof fetch,
			() => new Date("2026-09-02T08:00:00.000Z"),
		);

		await client.execute("project.read", { projectId: "project-1" });
		await client.execute("project.read", { projectId: "project-1" });

		expect(tokens).toHaveLength(2);
		expect(tokens[0]).not.toBe(tokens[1]);
		for (const token of tokens) {
			const [header, payload, signature] = token.split(".");
			expect(JSON.parse(Buffer.from(header, "base64url").toString())).toEqual({
				alg: "EdDSA",
				typ: "agent+jwt",
			});
			expect(
				JSON.parse(Buffer.from(payload, "base64url").toString()),
			).toMatchObject({
				iss: "host-1",
				sub: "agent-1",
				aud: "https://paca.example.com/api/auth/capability/execute",
				capabilities: ["project.read"],
				iat: 1_788_336_000,
				exp: 1_788_336_045,
			});
			expect(
				verify(
					null,
					Buffer.from(`${header}.${payload}`),
					createPublicKey({ key: fixture.publicKey, format: "jwk" }),
					Buffer.from(signature, "base64url"),
				),
			).toBe(true);
		}
	});

	it("refuses capabilities absent from the enrolled identity", async () => {
		const fixture = await writeConfig();
		const client = new AgentAuthClient(await loadAgentAuthConfig(fixture.path));
		await expect(client.execute("task.write", {})).rejects.toEqual(
			new AgentAuthClientError("AGENT_CAPABILITY_NOT_REQUESTED"),
		);
	});

	it("reports local harness identity without changing business permissions", () => {
		expect(
			createAgentHeartbeatReport({
				kind: "codex",
				version: "1.2.3",
				instanceId: "local-1",
			}),
		).toEqual({
			harnesses: [{ kind: "codex", version: "1.2.3", instanceId: "local-1" }],
			labels: ["task:execute"],
		});
		expect(() => createAgentHeartbeatReport({ kind: "unknown" })).toThrow(
			"PACA_AGENT_HARNESS_INVALID",
		);
	});
});
