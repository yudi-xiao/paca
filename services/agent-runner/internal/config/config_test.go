package config

import (
	"testing"
	"time"
)

func TestValidatePortRange(t *testing.T) {
	cases := []struct {
		name       string
		start, end int
		wantErr    bool
	}{
		{"both zero disables the feature", 0, 0, false},
		{"valid range", 2200, 2299, false},
		{"start equals end", 2200, 2200, false},
		{"only start set", 2200, 0, true},
		{"only end set", 0, 2299, true},
		{"end before start", 2299, 2200, true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			err := validatePortRange("SSH_BASTION_PORT_RANGE", tc.start, tc.end)
			if tc.wantErr && err == nil {
				t.Errorf("validatePortRange(%d, %d) = nil, want error", tc.start, tc.end)
			}
			if !tc.wantErr && err != nil {
				t.Errorf("validatePortRange(%d, %d) = %v, want nil", tc.start, tc.end, err)
			}
		})
	}
}

func TestLoadAgentAuthPresenceSettings(t *testing.T) {
	setRequiredEnvironment(t)
	t.Setenv("PACA_AGENT_CONFIG", "/private/agent.json")
	t.Setenv("PACA_AGENT_HARNESS_KIND", "deepseek")
	t.Setenv("PACA_AGENT_HARNESS_VERSION", "1.2.3")
	t.Setenv("PACA_AGENT_HARNESS_INSTANCE_ID", "local-arm64")
	t.Setenv("PACA_AGENT_HEARTBEAT_SECONDS", "45")
	t.Setenv("PACA_AGENT_TASK_LEASE_SECONDS", "120")

	settings, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if settings.AgentAuthConfigPath != "/private/agent.json" ||
		settings.AgentHarnessKind != "deepseek" ||
		settings.AgentHarnessVersion != "1.2.3" ||
		settings.AgentHarnessInstanceID != "local-arm64" ||
		settings.AgentHeartbeatInterval != 45*time.Second ||
		settings.AgentTaskLeaseDuration != 120*time.Second {
		t.Fatalf("Agent Auth settings = %#v", settings)
	}
}

func TestLoadRejectsInvalidAgentAuthPresenceSettings(t *testing.T) {
	for _, fixture := range []struct {
		name, kind, seconds string
	}{
		{name: "unknown harness", kind: "unknown", seconds: "30"},
		{name: "heartbeat is not an integer", kind: "codex", seconds: "fast"},
		{name: "heartbeat too frequent", kind: "codex", seconds: "9"},
		{name: "heartbeat too slow", kind: "codex", seconds: "61"},
	} {
		t.Run(fixture.name, func(t *testing.T) {
			setRequiredEnvironment(t)
			t.Setenv("PACA_AGENT_CONFIG", "/private/agent.json")
			t.Setenv("PACA_AGENT_HARNESS_KIND", fixture.kind)
			t.Setenv("PACA_AGENT_HEARTBEAT_SECONDS", fixture.seconds)
			if _, err := Load(); err == nil {
				t.Fatal("Load() error = nil")
			}
		})
	}
	t.Run("lease duration invalid", func(t *testing.T) {
		setRequiredEnvironment(t)
		t.Setenv("PACA_AGENT_CONFIG", "/private/agent.json")
		t.Setenv("PACA_AGENT_HARNESS_KIND", "codex")
		t.Setenv("PACA_AGENT_TASK_LEASE_SECONDS", "301")
		if _, err := Load(); err == nil {
			t.Fatal("Load() error = nil")
		}
	})
}

func setRequiredEnvironment(t *testing.T) {
	t.Helper()
	for key, value := range map[string]string{
		"DATABASE_URL":                   "postgres://localhost/paca",
		"VALKEY_URL":                     "redis://localhost:6379/0",
		"ENCRYPTION_KEY":                 "0000000000000000000000000000000000000000000000000000000000000000",
		"AGENT_SERVER_IMAGE":             "paca-agent:test",
		"INTERNAL_API_KEY":               "test-only",
		"AGENT_RUNNER_ALLOWED_AGENT_IDS": "*",
		"SANDBOX_BACKEND":                "docker",
	} {
		t.Setenv(key, value)
	}
}
