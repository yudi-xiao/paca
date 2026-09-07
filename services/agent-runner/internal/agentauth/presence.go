package agentauth

import (
	"context"
	"errors"
	"regexp"
	"time"
)

const TaskExecutionCapability = "task.execute"

var (
	harnessKinds = map[string]struct{}{
		"cloudflare-agent": {},
		"codex":            {},
		"claude-code":      {},
		"deepseek":         {},
		"custom":           {},
	}
	hostLabelPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9._:-]*$`)
)

// Harness identifies the execution implementation without changing the
// Agent's business permissions. Kind mirrors the Worker protocol catalogue.
type Harness struct {
	Kind       string `json:"kind"`
	Version    string `json:"version,omitempty"`
	InstanceID string `json:"instanceId,omitempty"`
}

type HeartbeatReport struct {
	Harnesses []Harness `json:"harnesses"`
	Labels    []string  `json:"labels"`
}

// NewHeartbeatReport validates the public presence metadata before it can be
// sent. The server independently intersects reported labels with labels an
// administrator approved for the Host.
func NewHeartbeatReport(harness Harness, labels []string) (HeartbeatReport, error) {
	if _, allowed := harnessKinds[harness.Kind]; !allowed || len(harness.Version) > 100 ||
		len(harness.InstanceID) > 255 {
		return HeartbeatReport{}, ErrConfigInvalid
	}
	if len(labels) > 32 {
		return HeartbeatReport{}, ErrConfigInvalid
	}
	unique := make([]string, 0, len(labels))
	seen := make(map[string]struct{}, len(labels))
	for _, label := range labels {
		if len(label) > 64 || !hostLabelPattern.MatchString(label) {
			return HeartbeatReport{}, ErrConfigInvalid
		}
		if _, duplicate := seen[label]; duplicate {
			continue
		}
		seen[label] = struct{}{}
		unique = append(unique, label)
	}
	return HeartbeatReport{Harnesses: []Harness{harness}, Labels: unique}, nil
}

// RunHeartbeatLoop refreshes Host presence until ctx is cancelled. Callers
// must perform one synchronous Heartbeat before starting this loop so an
// invalid, pending or revoked identity fails startup instead of looking ready.
func (client *Client) RunHeartbeatLoop(
	ctx context.Context,
	interval time.Duration,
	report HeartbeatReport,
	onError func(error),
) {
	if interval <= 0 {
		if onError != nil {
			onError(ErrConfigInvalid)
		}
		return
	}
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if _, err := client.Heartbeat(ctx, report); err != nil &&
				onError != nil && !errors.Is(err, context.Canceled) {
				onError(err)
			}
		}
	}
}
