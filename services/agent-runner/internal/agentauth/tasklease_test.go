package agentauth

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	testProjectID = "11111111-1111-4111-8111-111111111111"
	testTaskID    = "22222222-2222-4222-8222-222222222222"
	testLeaseID   = "33333333-3333-4333-8333-333333333333"
)

type taskLeaseServer struct {
	t             *testing.T
	mutex         sync.Mutex
	actions       []map[string]any
	discoveryBody string
}

func (server *taskLeaseServer) RoundTrip(request *http.Request) (*http.Response, error) {
	server.t.Helper()
	switch request.URL.Path {
	case "/api/v1/agent/host/heartbeat":
		return response(http.StatusOK, `{"success":true,"data":{"online":true}}`), nil
	case "/api/v1/agent/tasks/claimable":
		return response(http.StatusOK, server.discoveryBody), nil
	case "/api/auth/capability/execute":
		body, err := io.ReadAll(request.Body)
		if err != nil {
			server.t.Fatal(err)
		}
		var input struct {
			Capability string         `json:"capability"`
			Arguments  map[string]any `json:"arguments"`
		}
		if err := json.Unmarshal(body, &input); err != nil {
			server.t.Fatal(err)
		}
		if input.Capability != TaskExecutionCapability {
			server.t.Fatalf("capability = %q", input.Capability)
		}
		server.mutex.Lock()
		server.actions = append(server.actions, input.Arguments)
		server.mutex.Unlock()
		status := "active"
		var finishedAt any
		checkpointSequence := int64(0)
		switch input.Arguments["action"] {
		case "checkpoint":
			checkpointSequence = int64(input.Arguments["sequence"].(float64))
		case "complete":
			status = "completed"
			finishedAt = "2026-09-07T01:02:20Z"
		case "fail":
			status = "failed"
			finishedAt = "2026-09-07T01:02:20Z"
		}
		lease := map[string]any{
			"id": testLeaseID, "organizationId": "paca-default", "projectId": testProjectID,
			"taskId": testTaskID, "agentId": "agent-1", "hostId": "host-1",
			"harness": map[string]any{"kind": "codex", "version": "1.0.0", "instanceId": "local-1"},
			"status":  status, "version": 2, "lastCheckpointSequence": checkpointSequence,
			"leaseExpiresAt": "2026-09-07T01:03:03Z", "claimedAt": "2026-09-07T01:02:03Z",
			"finishedAt": finishedAt, "errorCode": nil, "resultSummary": nil,
			"createdAt": "2026-09-07T01:02:03Z", "updatedAt": "2026-09-07T01:02:04Z",
		}
		encoded, err := json.Marshal(map[string]any{
			"data": map[string]any{"duplicate": false, "lease": lease},
		})
		if err != nil {
			server.t.Fatal(err)
		}
		return response(http.StatusOK, string(encoded)), nil
	default:
		server.t.Fatalf("unexpected request: %s %s", request.Method, request.URL.Path)
		return nil, nil
	}
}

func taskDiscovery(availability string, lease any) string {
	body, _ := json.Marshal(map[string]any{
		"success": true,
		"data": []any{map[string]any{
			"organization_id": "paca-default", "project_id": testProjectID,
			"task_id": testTaskID, "task_number": 1, "title": "Execute approved work",
			"status_id": nil, "task_updated_at": "2026-09-07T01:02:03Z",
			"valid_until": "2026-09-07T01:12:03.000Z", "availability": availability,
			"lease": lease,
		}},
	})
	return string(body)
}

func taskLeaseControllerFixture(t *testing.T, discovery string) (TaskLeaseCoordinator, *taskLeaseServer) {
	t.Helper()
	server := &taskLeaseServer{t: t, discoveryBody: discovery}
	config := configFixture(t)
	client, err := NewClient(config, server)
	if err != nil {
		t.Fatal(err)
	}
	client.now = func() time.Time { return time.Date(2026, 9, 7, 1, 2, 3, 0, time.UTC) }
	harness := Harness{Kind: "codex", Version: "1.0.0", InstanceID: "local-1"}
	heartbeat, err := NewHeartbeatReport(harness, []string{"task:execute"})
	if err != nil {
		t.Fatal(err)
	}
	controller, err := NewTaskLeaseCoordinator(
		client, config.AgentID, config.HostID, harness, heartbeat, time.Minute,
	)
	if err != nil {
		t.Fatal(err)
	}
	return controller, server
}

func TestTaskLeaseCoordinatorClaimsAndFinalizesExactDiscoveredTask(t *testing.T) {
	controller, server := taskLeaseControllerFixture(t, taskDiscovery("claimable", nil))
	if !controller.Manages("agent-1") || controller.Manages("another-agent") {
		t.Fatal("coordinator Agent ownership is incorrect")
	}
	execution, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := execution.Complete(context.Background(), "completed by runner"); err != nil {
		t.Fatal(err)
	}

	server.mutex.Lock()
	defer server.mutex.Unlock()
	if len(server.actions) != 2 {
		t.Fatalf("actions = %#v", server.actions)
	}
	claim, complete := server.actions[0], server.actions[1]
	if claim["action"] != "claim" || claim["organizationId"] != "paca-default" ||
		claim["projectId"] != testProjectID || claim["taskId"] != testTaskID ||
		claim["validUntil"] != "2026-09-07T01:12:03.000Z" || claim["leaseDurationMs"] != float64(60_000) {
		t.Fatalf("claim = %#v", claim)
	}
	if complete["action"] != "complete" || complete["leaseId"] != testLeaseID ||
		complete["summary"] != "completed by runner" {
		t.Fatalf("complete = %#v", complete)
	}
	if claim["requestId"] == complete["requestId"] {
		t.Fatal("claim and complete reused requestId")
	}
}

func TestTaskLeaseExecutionPersistsMonotonicCheckpoint(t *testing.T) {
	controller, server := taskLeaseControllerFixture(t, taskDiscovery("claimable", nil))
	execution, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := execution.Checkpoint(context.Background(), 1, "sandbox ready"); err != nil {
		t.Fatal(err)
	}
	if len(server.actions) != 2 || server.actions[1]["action"] != "checkpoint" ||
		server.actions[1]["sequence"] != float64(1) || server.actions[1]["summary"] != "sandbox ready" {
		t.Fatalf("actions = %#v", server.actions)
	}
	if err := execution.Checkpoint(context.Background(), 0, "invalid"); !errors.Is(err, ErrTaskLeaseInvalid) {
		t.Fatalf("invalid checkpoint error = %v", err)
	}
}

func TestTaskLeaseCoordinatorResumesOnlyTheSameHarness(t *testing.T) {
	owned := map[string]any{
		"id": testLeaseID, "harness_kind": "codex", "harness_version": "1.0.0",
		"harness_instance_id": "local-1", "status": "active", "version": 1,
		"last_checkpoint_sequence": 0, "lease_expires_at": "2026-09-07T01:03:03Z",
	}
	controller, server := taskLeaseControllerFixture(t, taskDiscovery("owned", owned))
	execution, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := execution.Fail(context.Background(), "AGENT_RUNNER_FAILED", "provider unavailable"); err != nil {
		t.Fatal(err)
	}
	if len(server.actions) != 2 || server.actions[0]["action"] != "renew" ||
		server.actions[1]["action"] != "fail" {
		t.Fatalf("actions = %#v", server.actions)
	}

	owned["harness_instance_id"] = "other-runner"
	controller, _ = taskLeaseControllerFixture(t, taskDiscovery("owned", owned))
	if _, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID); !errors.Is(err, ErrTaskLeaseOwnedElsewhere) {
		t.Fatalf("mismatched harness error = %v", err)
	}
}

func TestTaskLeaseCoordinatorRejectsUndiscoveredOrWrongAgentWork(t *testing.T) {
	controller, server := taskLeaseControllerFixture(t, taskDiscovery("claimable", nil))
	if _, err := controller.Begin(context.Background(), "another-agent", testProjectID, testTaskID); !errors.Is(err, ErrTaskNotAuthorized) {
		t.Fatalf("wrong Agent error = %v", err)
	}
	if len(server.actions) != 0 {
		t.Fatalf("wrong Agent reached lease mutation: %#v", server.actions)
	}

	server.discoveryBody = `{"success":true,"data":[]}`
	if _, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID); !errors.Is(err, ErrTaskNotAuthorized) {
		t.Fatalf("undiscovered task error = %v", err)
	}
}

func TestTaskLeaseCoordinatorRejectsMalformedProtocolAndTerminalInput(t *testing.T) {
	controller, server := taskLeaseControllerFixture(t, `{"success":true,"data":[{"bad":true}]}`)
	if _, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID); !errors.Is(err, ErrTaskLeaseInvalid) {
		t.Fatalf("malformed discovery error = %v", err)
	}

	server.discoveryBody = taskDiscovery("claimable", nil)
	execution, err := controller.Begin(context.Background(), "agent-1", testProjectID, testTaskID)
	if err != nil {
		t.Fatal(err)
	}
	if err := execution.Fail(context.Background(), "bad code", ""); !errors.Is(err, ErrTaskLeaseInvalid) {
		t.Fatalf("invalid failure code error = %v", err)
	}
	if err := execution.Complete(context.Background(), strings.Repeat("x", 16_001)); !errors.Is(err, ErrTaskLeaseInvalid) {
		t.Fatalf("oversized summary error = %v", err)
	}
}
