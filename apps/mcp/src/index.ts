#!/usr/bin/env node

import { createRequire } from "node:module";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
	AgentAuthClient,
	CapabilityBrokerClient,
	createAgentHeartbeatReport,
	loadAgentAuthConfig,
	loadCapabilityBrokerConfig,
} from "./agent-auth/client.js";
import { createAgentCapabilityServer } from "./agent-auth/server.js";
import { applyPacaEnvironmentPrefix } from "./runtime-env.js";
import type { PacaConfig } from "./types/index.js";

const require = createRequire(import.meta.url);

/**
 * Main entry point for the Paca MCP server.
 * Initializes the API clients and starts the MCP server.
 */
async function main() {
	// Handle --version flag
	if (process.argv.includes("--version") || process.argv.includes("-v")) {
		const { version } = require("../package.json") as { version: string };
		console.log(version);
		process.exit(0);
	}

	applyPacaEnvironmentPrefix(process.argv, process.env);

	// Get configuration from environment variables
	const apiKey = process.env.PACA_API_KEY;
	const agentConfigPath = process.env.PACA_AGENT_CONFIG?.trim();
	const capabilityBrokerURL = process.env.PACA_CAPABILITY_BROKER_URL?.trim();
	const capabilityBrokerToken =
		process.env.PACA_CAPABILITY_BROKER_TOKEN?.trim();
	const capabilityBrokerConfig =
		process.env.PACA_CAPABILITY_BROKER_CONFIG?.trim();
	const baseURL = process.env.PACA_API_URL || "http://localhost:8080";
	const gatewayURL = process.env.PACA_GATEWAY_URL || undefined;
	const agentId = process.env.PACA_AGENT_ID || undefined;
	const projectId = process.env.PACA_PROJECT_ID || undefined;
	const actorUserId = process.env.PACA_ACTOR_USER_ID || undefined;
	// Comma-separated plugin names — see agent-runner's executor.go
	// buildMCPServers, which sets this from trigger.RepoPluginIDs (itself
	// decoded from the paca:agent:triggers stream's repo_plugin_ids field).
	const repoPluginIds = process.env.PACA_REPO_PLUGIN_IDS
		? process.env.PACA_REPO_PLUGIN_IDS.split(",").filter(Boolean)
		: undefined;

	const brokerValues = [
		capabilityBrokerURL,
		capabilityBrokerToken,
		capabilityBrokerConfig,
	].filter(Boolean).length;
	if (
		(apiKey ? 1 : 0) + (agentConfigPath ? 1 : 0) + (brokerValues > 0 ? 1 : 0) >
		1
	) {
		console.error(
			"PACA_AUTH_MODE_AMBIGUOUS: select exactly one Paca authentication mode.",
		);
		process.exit(1);
	}
	if (brokerValues > 0 && brokerValues !== 3) {
		console.error(
			"PACA_CAPABILITY_BROKER_CONFIG_INVALID: URL, token, and config are all required.",
		);
		process.exit(1);
	}
	if (capabilityBrokerURL && capabilityBrokerToken && capabilityBrokerConfig) {
		const config = loadCapabilityBrokerConfig(capabilityBrokerConfig);
		const server = createAgentCapabilityServer(
			new CapabilityBrokerClient(
				config,
				capabilityBrokerURL,
				capabilityBrokerToken,
			),
			config.projectId,
		);
		const transport = new StdioServerTransport();
		await server.connect(transport);
		return;
	}
	if (agentConfigPath) {
		const config = await loadAgentAuthConfig(agentConfigPath);
		const heartbeat = createAgentHeartbeatReport({
			kind: process.env.PACA_AGENT_HARNESS_KIND?.trim() || "custom",
			version: process.env.PACA_AGENT_HARNESS_VERSION?.trim() || undefined,
			instanceId:
				process.env.PACA_AGENT_HARNESS_INSTANCE_ID?.trim() || undefined,
		});
		const server = createAgentCapabilityServer(
			new AgentAuthClient(config),
			projectId,
			heartbeat,
		);
		const transport = new StdioServerTransport();
		await server.connect(transport);
		return;
	}

	// Validate required legacy configuration
	if (!apiKey) {
		console.error(
			"PACA_API_KEY environment variable is required. Please set it to your Paca API key.",
		);
		console.error("\nExample:");
		console.error("  export PACA_API_KEY='your-api-key-here'");
		console.error("  export PACA_API_URL='http://localhost:8080'");
		process.exit(1);
	}

	// PACA_PROJECT_ID pins every tool call to a single project ("single-project
	// agent mode" — see server.ts). It's optional when PACA_AGENT_ID is set:
	// a global-scope agent (services/agent-runner's buildMCPServers omits
	// PACA_PROJECT_ID entirely for a global-chat conversation) runs "unpinned"
	// instead, the same mode a personal API key with no project already uses —
	// each tool call may target any project the agent has permission in
	// (e.g. list/create/update a project, or work within one it's been
	// invited into), passed explicitly per call rather than pinned once at
	// startup. See fetchAgentPermissions in permissions.ts.

	// Create configuration object
	const config: PacaConfig = {
		apiKey,
		baseURL,
		gatewayURL,
		agentId,
		projectId,
		actorUserId,
		repoPluginIds,
	};

	// Create and configure MCP server (loads plugin modules asynchronously)
	// Dynamic on purpose: runtime-env must restore a conversation-prefixed
	// PACA_WORKDIR before repo-tools evaluates its module-level default.
	const { createServer } = await import("./server.js");
	const server = await createServer(config);

	// Connect to stdio transport
	const transport = new StdioServerTransport();
	await server.connect(transport);
}

// Handle errors and exit gracefully
main().catch((error) => {
	console.error("Server error:", error);
	process.exit(1);
});
