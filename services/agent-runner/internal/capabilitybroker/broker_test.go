package capabilitybroker

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Paca-AI/agent-runner/internal/agentauth"
)

const (
	testAgentID        = "11111111-1111-4111-8111-111111111111"
	testConversationID = "22222222-2222-4222-8222-222222222222"
	testProjectID      = "33333333-3333-4333-8333-333333333333"
	otherProjectID     = "44444444-4444-4444-8444-444444444444"
)

type fakeAgentClient struct {
	executeCalls int
	requestCalls int
}

func (client *fakeAgentClient) ExecuteCapability(_ context.Context, _ string, _ map[string]any) (json.RawMessage, error) {
	client.executeCalls++
	return json.RawMessage(`{"data":{"ok":true}}`), nil
}

func (client *fakeAgentClient) RequestAgent(_ context.Context, _, _ string, _ []string, _ []byte) (json.RawMessage, error) {
	client.requestCalls++
	return json.RawMessage(`{"data":{"status":"queued"}}`), nil
}

func identity() *agentauth.Config {
	validUntil := "2099-01-01T00:00:00Z"
	return &agentauth.Config{
		Version:      1,
		AgentID:      testAgentID,
		Capabilities: []string{"project.read", "task.execute", "environment.connect", "workflow.execute"},
		GrantRequests: []agentauth.GrantRequest{
			{Capability: "project.read", Constraints: map[string]any{
				"organizationId": "org-1", "projectId": testProjectID, "validUntil": validUntil,
			}},
			{Capability: "task.execute", Constraints: map[string]any{
				"organizationId": "org-1", "projectId": testProjectID, "validUntil": validUntil,
			}},
			{Capability: "environment.connect", Constraints: map[string]any{
				"organizationId": "org-1", "projectId": testProjectID, "validUntil": validUntil,
			}},
			{Capability: "workflow.execute", Constraints: map[string]any{
				"organizationId": "org-1", "projectId": map[string]any{"eq": testProjectID}, "validUntil": validUntil,
			}},
			{Capability: "project.read", Constraints: map[string]any{
				"organizationId": "org-1", "projectId": otherProjectID, "validUntil": validUntil,
			}},
		},
	}
}

func newTestBroker(t *testing.T) (*Broker, *fakeAgentClient, Session) {
	t.Helper()
	client := &fakeAgentClient{}
	broker, err := New(client, identity())
	if err != nil {
		t.Fatal(err)
	}
	broker.now = func() time.Time { return time.Date(2026, 9, 9, 0, 0, 0, 0, time.UTC) }
	session, err := broker.Issue(testAgentID, testConversationID, testProjectID)
	if err != nil {
		t.Fatal(err)
	}
	return broker, client, session
}

func performBrokerRequest(t *testing.T, broker *Broker, session Session, body string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequestWithContext(
		context.Background(),
		http.MethodPost,
		"/agent-capabilities",
		bytes.NewBufferString(body),
	)
	request.Header.Set("Authorization", "Bearer "+session.Token)
	request.Header.Set("Content-Type", "application/json")
	response := httptest.NewRecorder()
	broker.ServeHTTP(response, request)
	return response
}

func TestIssueExposesOnlyPublicProjectScopedCapabilities(t *testing.T) {
	_, _, session := newTestBroker(t)
	if len(session.Token) != 43 {
		t.Fatalf("token length = %d, want 43", len(session.Token))
	}
	decoded, err := base64.RawURLEncoding.DecodeString(session.EncodedConfig)
	if err != nil {
		t.Fatal(err)
	}
	var config publicConfig
	if err := json.Unmarshal(decoded, &config); err != nil {
		t.Fatal(err)
	}
	if config.AgentID != testAgentID || config.ProjectID != testProjectID {
		t.Fatalf("public config scope = %#v", config)
	}
	if len(config.Capabilities) != 2 || config.Capabilities[0] != "project.read" || config.Capabilities[1] != "workflow.execute" {
		t.Fatalf("capabilities = %#v", config.Capabilities)
	}
	for _, grant := range config.GrantRequests {
		if grant.Capability == "task.execute" || grant.Capability == "environment.connect" || exactString(grant.Constraints["projectId"]) != testProjectID {
			t.Fatalf("unsafe grant exposed: %#v", grant)
		}
	}
}

func TestBrokerForwardsAllowedCapabilityWithoutExposingAgentKey(t *testing.T) {
	broker, client, session := newTestBroker(t)
	response := performBrokerRequest(t, broker, session, `{
		"operation":"execute",
		"capability":"project.read",
		"arguments":{"organizationId":"org-1","projectId":"33333333-3333-4333-8333-333333333333","validUntil":"2099-01-01T00:00:00Z"}
	}`)
	if response.Code != http.StatusOK || client.executeCalls != 1 {
		t.Fatalf("status = %d, calls = %d, body = %s", response.Code, client.executeCalls, response.Body.String())
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("cache control = %q", response.Header().Get("Cache-Control"))
	}
}

func TestBrokerRejectsProjectEscapeAndRevokedToken(t *testing.T) {
	broker, client, session := newTestBroker(t)
	response := performBrokerRequest(t, broker, session, `{
		"operation":"execute",
		"capability":"project.read",
		"arguments":{"projectId":"44444444-4444-4444-8444-444444444444"}
	}`)
	if response.Code != http.StatusForbidden || client.executeCalls != 0 {
		t.Fatalf("status = %d, calls = %d", response.Code, client.executeCalls)
	}

	broker.Revoke(session.Token)
	response = performBrokerRequest(t, broker, session, `{
		"operation":"execute",
		"capability":"project.read",
		"arguments":{"projectId":"33333333-3333-4333-8333-333333333333"}
	}`)
	if response.Code != http.StatusUnauthorized || client.executeCalls != 0 {
		t.Fatalf("status after revoke = %d, calls = %d", response.Code, client.executeCalls)
	}
}

func TestBrokerRestrictsAgentRequestToBoundProject(t *testing.T) {
	broker, client, session := newTestBroker(t)
	response := performBrokerRequest(t, broker, session, `{
		"operation":"agent_request",
		"method":"POST",
		"path":"/api/v1/agent/projects/33333333-3333-4333-8333-333333333333/runs/start",
		"capabilities":["workflow.execute"],
		"body":{"requestId":"55555555-5555-4555-8555-555555555555"}
	}`)
	if response.Code != http.StatusOK || client.requestCalls != 1 {
		t.Fatalf("status = %d, calls = %d, body = %s", response.Code, client.requestCalls, response.Body.String())
	}

	response = performBrokerRequest(t, broker, session, `{
		"operation":"agent_request",
		"method":"GET",
		"path":"/api/v1/agent/projects/44444444-4444-4444-8444-444444444444/runs/1",
		"capabilities":["workflow.execute"],
		"body":null
	}`)
	if response.Code != http.StatusForbidden || client.requestCalls != 1 {
		t.Fatalf("escaped status = %d, calls = %d", response.Code, client.requestCalls)
	}

	for _, path := range []string{
		"/api/v1/agent/projects/33333333-3333-4333-8333-333333333333/../tasks",
		"/api/v1/agent/projects/33333333-3333-4333-8333-333333333333/%2e%2e/tasks",
	} {
		body, err := json.Marshal(map[string]any{
			"operation":    "agent_request",
			"method":       "GET",
			"path":         path,
			"capabilities": []string{"workflow.execute"},
		})
		if err != nil {
			t.Fatal(err)
		}
		response = performBrokerRequest(t, broker, session, string(body))
		if response.Code != http.StatusForbidden || client.requestCalls != 1 {
			t.Fatalf("path %q status = %d, calls = %d", path, response.Code, client.requestCalls)
		}
	}
}
