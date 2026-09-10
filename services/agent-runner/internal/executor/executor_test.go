package executor

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/google/uuid"

	"github.com/Paca-AI/agent-runner/internal/acp"
	"github.com/Paca-AI/agent-runner/internal/agent"
	"github.com/Paca-AI/agent-runner/internal/agentauth"
	"github.com/Paca-AI/agent-runner/internal/capabilitybroker"
	"github.com/Paca-AI/agent-runner/internal/sandbox"
)

func findPacaServer(t *testing.T, servers []acp.MCPServerConfig) acp.MCPServerConfig {
	t.Helper()
	for _, s := range servers {
		if s.Name == "paca" {
			return s
		}
	}
	t.Fatalf("no MCP server named %q in %+v", "paca", servers)
	return acp.MCPServerConfig{}
}

func envValue(env *[]acp.EnvVariable, name string) (string, bool) {
	if env == nil {
		return "", false
	}
	for _, e := range *env {
		if e.Name == name {
			return e.Value, true
		}
	}
	return "", false
}

func TestBuildMCPServers_SetsRepoPluginIDsWhenPresent(t *testing.T) {
	e := &Executor{opts: Options{PacaAPIKey: "key", PacaAPIURL: "http://api", PacaGatewayURL: "http://gw"}}
	trigger := agent.Trigger{
		ConversationID: uuid.New(),
		AgentID:        uuid.New(),
		RepoPluginIDs:  []string{"com.paca.github", "com.paca.gitlab"},
	}
	cfg := agent.Config{ID: uuid.New()}

	servers := e.buildMCPServers(trigger, cfg, nil)
	paca := findPacaServer(t, servers)

	val, ok := envValue(paca.Env, "PACA_REPO_PLUGIN_IDS")
	if !ok {
		t.Fatalf("PACA_REPO_PLUGIN_IDS not set in paca MCP server env: %+v", paca.Env)
	}
	if val != "com.paca.github,com.paca.gitlab" {
		t.Errorf("PACA_REPO_PLUGIN_IDS = %q, want %q", val, "com.paca.github,com.paca.gitlab")
	}
}

func TestBuildMCPServers_OmitsRepoPluginIDsWhenAbsent(t *testing.T) {
	e := &Executor{opts: Options{PacaAPIKey: "key", PacaAPIURL: "http://api", PacaGatewayURL: "http://gw"}}
	trigger := agent.Trigger{ConversationID: uuid.New(), AgentID: uuid.New()}
	cfg := agent.Config{ID: uuid.New()}

	servers := e.buildMCPServers(trigger, cfg, nil)
	paca := findPacaServer(t, servers)

	if _, ok := envValue(paca.Env, "PACA_REPO_PLUGIN_IDS"); ok {
		t.Errorf("PACA_REPO_PLUGIN_IDS should be omitted when trigger.RepoPluginIDs is empty, env: %+v", paca.Env)
	}
}

func TestBuildMCPServers_UsesCapabilityBrokerWithoutLegacyCredential(t *testing.T) {
	e := &Executor{opts: Options{
		PacaAPIKey:          "legacy-key-must-not-be-used",
		CapabilityBrokerURL: "http://agent-runner:8080/agent-capabilities",
	}}
	trigger := agent.Trigger{ConversationID: uuid.New(), AgentID: uuid.New(), ProjectID: uuid.New()}
	cfg := agent.Config{ID: trigger.AgentID}
	session := &capabilitybroker.Session{
		Token:         "opaque-broker-token",
		EncodedConfig: "public-config",
	}

	paca := findPacaServer(t, e.buildMCPServers(trigger, cfg, session))
	for name, want := range map[string]string{
		"PACA_CAPABILITY_BROKER_URL":    "http://agent-runner:8080/agent-capabilities",
		"PACA_CAPABILITY_BROKER_TOKEN":  "opaque-broker-token",
		"PACA_CAPABILITY_BROKER_CONFIG": "public-config",
	} {
		if got, ok := envValue(paca.Env, name); !ok || got != want {
			t.Fatalf("%s = %q, %v; want %q", name, got, ok, want)
		}
	}
	for _, forbidden := range []string{"PACA_API_KEY", "PACA_AGENT_CONFIG"} {
		if value, ok := envValue(paca.Env, forbidden); ok {
			t.Fatalf("%s leaked into brokered sandbox as %q", forbidden, value)
		}
	}
}

type brokerAgentClient struct{}

func (brokerAgentClient) ExecuteCapability(context.Context, string, map[string]any) (json.RawMessage, error) {
	return json.RawMessage(`{"data":{}}`), nil
}

func (brokerAgentClient) RequestAgent(context.Context, string, string, []string, []byte) (json.RawMessage, error) {
	return json.RawMessage(`{"data":{}}`), nil
}

type stopOnlyBackend struct {
	sandbox.FullBackend
	stopped bool
}

func (backend *stopOnlyBackend) Stop(_ context.Context, _ *sandbox.Handle) error {
	backend.stopped = true
	return nil
}

func TestStopSandboxRevokesCapabilityBrokerBearer(t *testing.T) {
	agentID := uuid.New().String()
	projectID := uuid.New().String()
	identity := &agentauth.Config{
		AgentID:      agentID,
		Capabilities: []string{"project.read"},
		GrantRequests: []agentauth.GrantRequest{{
			Capability: "project.read",
			Constraints: map[string]any{
				"organizationId": "org-1",
				"projectId":      projectID,
				"validUntil":     "2099-01-01T00:00:00Z",
			},
		}},
	}
	broker, err := capabilitybroker.New(brokerAgentClient{}, identity)
	if err != nil {
		t.Fatal(err)
	}
	session, err := broker.Issue(agentID, uuid.New().String(), projectID)
	if err != nil {
		t.Fatal(err)
	}
	backend := &stopOnlyBackend{}
	executor := &Executor{sandboxMgr: backend, opts: Options{CapabilityBroker: broker}}
	handle := &sandbox.Handle{ContainerID: "sandbox-1", CapabilityBrokerToken: session.Token}
	if err := executor.StopSandbox(context.Background(), handle); err != nil {
		t.Fatal(err)
	}
	if !backend.stopped || handle.CapabilityBrokerToken != "" {
		t.Fatalf("stop state = stopped:%v token:%q", backend.stopped, handle.CapabilityBrokerToken)
	}

	request := httptest.NewRequest(
		http.MethodPost,
		"/agent-capabilities",
		bytes.NewBufferString(`{"operation":"execute","capability":"project.read","arguments":{"projectId":"`+projectID+`"}}`),
	)
	request.Header.Set("Authorization", "Bearer "+session.Token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	broker.ServeHTTP(response, request)
	if response.Code != http.StatusUnauthorized {
		t.Fatalf("status after sandbox stop = %d, want 401", response.Code)
	}
}
