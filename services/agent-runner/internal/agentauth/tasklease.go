package agentauth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	minimumTaskLeaseDuration = 5 * time.Second
	maximumTaskLeaseDuration = 5 * time.Minute
)

var (
	ErrTaskLeaseInvalid        = errors.New("agentauth: task lease protocol invalid")
	ErrTaskNotAuthorized       = errors.New("agentauth: task not authorized for execution")
	ErrTaskLeaseOwnedElsewhere = errors.New("agentauth: task lease belongs to another harness")
)

type DiscoveredTaskLease struct {
	ID                     string    `json:"id"`
	HarnessKind            string    `json:"harness_kind"`
	HarnessVersion         *string   `json:"harness_version"`
	HarnessInstanceID      *string   `json:"harness_instance_id"`
	Status                 string    `json:"status"`
	Version                int64     `json:"version"`
	LastCheckpointSequence int64     `json:"last_checkpoint_sequence"`
	LeaseExpiresAt         time.Time `json:"lease_expires_at"`
}

type DiscoveredTask struct {
	OrganizationID string    `json:"organization_id"`
	ProjectID      string    `json:"project_id"`
	TaskID         string    `json:"task_id"`
	TaskNumber     int64     `json:"task_number"`
	Title          string    `json:"title"`
	StatusID       *string   `json:"status_id"`
	TaskUpdatedAt  time.Time `json:"task_updated_at"`
	// ValidUntil deliberately remains the exact wire string. Reformatting an
	// equivalent instant (for example .000Z to Z) would no longer equal the
	// Grant's exact string constraint at capability execution time.
	ValidUntil   string               `json:"valid_until"`
	Availability string               `json:"availability"`
	Lease        *DiscoveredTaskLease `json:"lease"`
}

type TaskLease struct {
	ID                     string     `json:"id"`
	OrganizationID         string     `json:"organizationId"`
	ProjectID              string     `json:"projectId"`
	TaskID                 string     `json:"taskId"`
	AgentID                string     `json:"agentId"`
	HostID                 string     `json:"hostId"`
	Harness                Harness    `json:"harness"`
	Status                 string     `json:"status"`
	Version                int64      `json:"version"`
	LastCheckpointSequence int64      `json:"lastCheckpointSequence"`
	LeaseExpiresAt         time.Time  `json:"leaseExpiresAt"`
	ClaimedAt              time.Time  `json:"claimedAt"`
	FinishedAt             *time.Time `json:"finishedAt"`
	ErrorCode              *string    `json:"errorCode"`
	ResultSummary          *string    `json:"resultSummary"`
	CreatedAt              time.Time  `json:"createdAt"`
	UpdatedAt              time.Time  `json:"updatedAt"`
}

type TaskLeaseResult struct {
	Duplicate bool      `json:"duplicate"`
	Lease     TaskLease `json:"lease"`
}

// DiscoverTasks returns only work derived by the Worker from active,
// constraint-exact task.execute Grants. The caller cannot add scope by
// supplying its own project or task identifiers.
func (client *Client) DiscoverTasks(ctx context.Context) ([]DiscoveredTask, error) {
	raw, err := client.discoverTasks(ctx)
	if err != nil {
		return nil, err
	}
	var tasks []DiscoveredTask
	if err := decodeProtocolData(raw, &tasks); err != nil || len(tasks) > 100 {
		return nil, ErrTaskLeaseInvalid
	}
	for index := range tasks {
		if err := validateDiscoveredTask(tasks[index]); err != nil {
			return nil, err
		}
	}
	return tasks, nil
}

func decodeProtocolData(raw json.RawMessage, target any) error {
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err == nil && len(envelope.Data) > 0 {
		return json.Unmarshal(envelope.Data, target)
	}
	return json.Unmarshal(raw, target)
}

func validateDiscoveredTask(task DiscoveredTask) error {
	if strings.TrimSpace(task.OrganizationID) == "" || len(task.OrganizationID) > 255 ||
		uuid.Validate(task.ProjectID) != nil || uuid.Validate(task.TaskID) != nil ||
		task.TaskNumber < 1 || strings.TrimSpace(task.Title) == "" || task.TaskUpdatedAt.IsZero() ||
		task.ValidUntil == "" || (task.Availability != "claimable" && task.Availability != "owned") {
		return ErrTaskLeaseInvalid
	}
	if _, err := time.Parse(time.RFC3339, task.ValidUntil); err != nil {
		return ErrTaskLeaseInvalid
	}
	if task.Availability == "claimable" && task.Lease != nil {
		return ErrTaskLeaseInvalid
	}
	if task.Availability == "owned" {
		if task.Lease == nil || uuid.Validate(task.Lease.ID) != nil || task.Lease.Status != "active" ||
			task.Lease.Version < 1 || task.Lease.LastCheckpointSequence < 0 || task.Lease.LeaseExpiresAt.IsZero() {
			return ErrTaskLeaseInvalid
		}
		if _, allowed := harnessKinds[task.Lease.HarnessKind]; !allowed {
			return ErrTaskLeaseInvalid
		}
	}
	return nil
}

type TaskLeaseCoordinator interface {
	Manages(agentID string) bool
	Begin(ctx context.Context, agentID, projectID, taskID string) (TaskLeaseExecution, error)
}

type TaskLeaseExecution interface {
	StartRenewal(ctx context.Context, onError func(error)) func()
	Checkpoint(ctx context.Context, sequence int64, summary string) error
	Complete(ctx context.Context, summary string) error
	Fail(ctx context.Context, errorCode, summary string) error
}

type taskLeaseController struct {
	client        *Client
	agentID       string
	hostID        string
	harness       Harness
	heartbeat     HeartbeatReport
	leaseDuration time.Duration
}

func NewTaskLeaseCoordinator(
	client *Client,
	agentID string,
	hostID string,
	harness Harness,
	heartbeat HeartbeatReport,
	leaseDuration time.Duration,
) (TaskLeaseCoordinator, error) {
	if client == nil || strings.TrimSpace(agentID) == "" || strings.TrimSpace(hostID) == "" ||
		leaseDuration < minimumTaskLeaseDuration || leaseDuration > maximumTaskLeaseDuration {
		return nil, ErrConfigInvalid
	}
	validated, err := NewHeartbeatReport(harness, heartbeat.Labels)
	if err != nil || len(heartbeat.Harnesses) != 1 || heartbeat.Harnesses[0] != validated.Harnesses[0] {
		return nil, ErrConfigInvalid
	}
	return &taskLeaseController{
		client: client, agentID: agentID, hostID: hostID, harness: harness,
		heartbeat: validated, leaseDuration: leaseDuration,
	}, nil
}

func (controller *taskLeaseController) Manages(agentID string) bool {
	return agentID == controller.agentID
}

func (controller *taskLeaseController) Begin(
	ctx context.Context,
	agentID string,
	projectID string,
	taskID string,
) (TaskLeaseExecution, error) {
	if agentID != controller.agentID || uuid.Validate(projectID) != nil || uuid.Validate(taskID) != nil {
		return nil, ErrTaskNotAuthorized
	}
	if _, err := controller.client.Heartbeat(ctx, controller.heartbeat); err != nil {
		return nil, err
	}
	tasks, err := controller.client.DiscoverTasks(ctx)
	if err != nil {
		return nil, err
	}
	var selected *DiscoveredTask
	for index := range tasks {
		if tasks[index].ProjectID == projectID && tasks[index].TaskID == taskID {
			selected = &tasks[index]
			break
		}
	}
	if selected == nil {
		return nil, ErrTaskNotAuthorized
	}
	validUntil, err := time.Parse(time.RFC3339, selected.ValidUntil)
	if err != nil || !validUntil.After(controller.client.now()) {
		return nil, ErrTaskNotAuthorized
	}
	execution := &taskLeaseExecution{
		controller: controller,
		scope: taskLeaseScope{
			OrganizationID: selected.OrganizationID,
			ProjectID:      selected.ProjectID,
			TaskID:         selected.TaskID,
			ValidUntil:     selected.ValidUntil,
		},
	}
	if selected.Availability == "owned" {
		if !sameHarness(selected.Lease, controller.harness) {
			return nil, ErrTaskLeaseOwnedElsewhere
		}
		execution.leaseID = selected.Lease.ID
		if err := execution.renew(ctx); err != nil {
			return nil, err
		}
		return execution, nil
	}
	result, err := controller.mutate(ctx, execution.claimCommand())
	if err != nil {
		return nil, err
	}
	if err := controller.validateResult(result, execution.scope, "active"); err != nil {
		return nil, err
	}
	execution.leaseID = result.Lease.ID
	return execution, nil
}

func sameHarness(lease *DiscoveredTaskLease, harness Harness) bool {
	if lease == nil || lease.HarnessKind != harness.Kind {
		return false
	}
	return optionalStringEquals(lease.HarnessVersion, harness.Version) &&
		optionalStringEquals(lease.HarnessInstanceID, harness.InstanceID)
}

func optionalStringEquals(value *string, expected string) bool {
	return (value == nil && expected == "") || (value != nil && *value == expected)
}

type taskLeaseScope struct {
	OrganizationID string
	ProjectID      string
	TaskID         string
	ValidUntil     string
}

type taskLeaseExecution struct {
	controller *taskLeaseController
	scope      taskLeaseScope
	leaseID    string
}

func (execution *taskLeaseExecution) baseCommand(action string) map[string]any {
	return map[string]any{
		"organizationId": execution.scope.OrganizationID,
		"projectId":      execution.scope.ProjectID,
		"taskId":         execution.scope.TaskID,
		"validUntil":     execution.scope.ValidUntil,
		"operationMode":  "execute",
		"requestId":      uuid.NewString(),
		"action":         action,
	}
}

func (execution *taskLeaseExecution) claimCommand() map[string]any {
	command := execution.baseCommand("claim")
	command["leaseDurationMs"] = execution.controller.leaseDuration.Milliseconds()
	command["harness"] = execution.controller.harness
	return command
}

func (controller *taskLeaseController) mutate(ctx context.Context, command map[string]any) (TaskLeaseResult, error) {
	if _, err := controller.client.Heartbeat(ctx, controller.heartbeat); err != nil {
		return TaskLeaseResult{}, err
	}
	raw, err := controller.client.ExecuteCapability(ctx, TaskExecutionCapability, command)
	if err != nil {
		return TaskLeaseResult{}, err
	}
	var result TaskLeaseResult
	if err := decodeProtocolData(raw, &result); err != nil {
		return TaskLeaseResult{}, ErrTaskLeaseInvalid
	}
	return result, nil
}

func (controller *taskLeaseController) validateResult(
	result TaskLeaseResult,
	scope taskLeaseScope,
	status string,
) error {
	lease := result.Lease
	if uuid.Validate(lease.ID) != nil || lease.OrganizationID != scope.OrganizationID ||
		lease.ProjectID != scope.ProjectID || lease.TaskID != scope.TaskID ||
		lease.AgentID != controller.agentID || lease.HostID != controller.hostID ||
		lease.Status != status || lease.Version < 1 || lease.LastCheckpointSequence < 0 ||
		lease.LeaseExpiresAt.IsZero() || lease.ClaimedAt.IsZero() || lease.CreatedAt.IsZero() ||
		lease.UpdatedAt.IsZero() || lease.Harness != controller.harness {
		return ErrTaskLeaseInvalid
	}
	return nil
}

func (execution *taskLeaseExecution) renew(ctx context.Context) error {
	command := execution.baseCommand("renew")
	command["leaseId"] = execution.leaseID
	command["leaseDurationMs"] = execution.controller.leaseDuration.Milliseconds()
	result, err := execution.controller.mutate(ctx, command)
	if err != nil {
		return err
	}
	return execution.controller.validateResult(result, execution.scope, "active")
}

func (execution *taskLeaseExecution) StartRenewal(
	ctx context.Context,
	onError func(error),
) func() {
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	var once sync.Once
	go func() {
		defer close(done)
		ticker := time.NewTicker(execution.controller.leaseDuration / 2)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if err := execution.renew(ctx); err != nil {
					if onError != nil && !errors.Is(err, context.Canceled) {
						onError(err)
					}
					return
				}
			}
		}
	}()
	return func() {
		once.Do(func() {
			cancel()
			<-done
		})
	}
}

func (execution *taskLeaseExecution) Complete(ctx context.Context, summary string) error {
	if utf8.RuneCountInString(summary) > 16_000 {
		return ErrTaskLeaseInvalid
	}
	command := execution.baseCommand("complete")
	command["leaseId"] = execution.leaseID
	command["summary"] = summary
	command["artifactKeys"] = []string{}
	result, err := execution.controller.mutate(ctx, command)
	if err != nil {
		return err
	}
	return execution.controller.validateResult(result, execution.scope, "completed")
}

func (execution *taskLeaseExecution) Checkpoint(
	ctx context.Context,
	sequence int64,
	summary string,
) error {
	if sequence < 1 || utf8.RuneCountInString(summary) > 4_000 {
		return ErrTaskLeaseInvalid
	}
	command := execution.baseCommand("checkpoint")
	command["leaseId"] = execution.leaseID
	command["sequence"] = sequence
	command["summary"] = summary
	command["checkpointKey"] = nil
	command["artifactKeys"] = []string{}
	result, err := execution.controller.mutate(ctx, command)
	if err != nil {
		return err
	}
	if err := execution.controller.validateResult(result, execution.scope, "active"); err != nil ||
		result.Lease.LastCheckpointSequence != sequence {
		return ErrTaskLeaseInvalid
	}
	return nil
}

func (execution *taskLeaseExecution) Fail(
	ctx context.Context,
	errorCode string,
	summary string,
) error {
	if !remoteCodePattern.MatchString(errorCode) || len(errorCode) > 100 ||
		utf8.RuneCountInString(summary) > 16_000 {
		return ErrTaskLeaseInvalid
	}
	command := execution.baseCommand("fail")
	command["leaseId"] = execution.leaseID
	command["errorCode"] = errorCode
	command["summary"] = summary
	command["artifactKeys"] = []string{}
	result, err := execution.controller.mutate(ctx, command)
	if err != nil {
		return err
	}
	if err := execution.controller.validateResult(result, execution.scope, "failed"); err != nil {
		return fmt.Errorf("%w: fail response", err)
	}
	return nil
}
