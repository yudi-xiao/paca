package agentauth

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

type roundTripFunc func(*http.Request) (*http.Response, error)

func (function roundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return function(request)
}

func configFixture(t *testing.T) *Config {
	t.Helper()
	seed := make([]byte, ed25519.SeedSize)
	for index := range seed {
		seed[index] = byte(index + 1)
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	publicKey := privateKey.Public().(ed25519.PublicKey)
	x := base64.RawURLEncoding.EncodeToString(publicKey)
	return &Config{
		Version:         1,
		ProviderOrigin:  "https://paca.test",
		Issuer:          "https://paca.test/api/auth",
		DefaultLocation: "https://paca.test/api/auth/capability/execute",
		HostID:          "host-1",
		AgentID:         "agent-1",
		AgentName:       "Runner Agent",
		KeyAlgorithm:    "Ed25519",
		PublicKey: JWK{
			KTY: "OKP", CRV: "Ed25519", X: x, Alg: "EdDSA", Use: "sig", KID: "kid-1",
			Ext: true, KeyOps: []string{"verify"},
		},
		PrivateKey: JWK{
			KTY: "OKP", CRV: "Ed25519", X: x,
			D: base64.RawURLEncoding.EncodeToString(seed), Alg: "EdDSA", Use: "sig", KID: "kid-1",
			Ext: true, KeyOps: []string{"sign"},
		},
		Capabilities: []string{"task.execute", "task.read"},
		GrantRequests: []GrantRequest{{
			Capability:  "task.execute",
			Constraints: map[string]any{"projectId": "project-1"},
		}},
		RegisteredAt: "2026-09-07T00:00:00Z",
	}
}

func response(status int, body string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     make(http.Header),
		Body:       io.NopCloser(strings.NewReader(body)),
	}
}

func decodeAndVerifyJWT(t *testing.T, token string, config *Config) agentClaims {
	t.Helper()
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		t.Fatalf("JWT has %d parts", len(parts))
	}
	headerBytes, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		t.Fatal(err)
	}
	var header map[string]string
	if err := json.Unmarshal(headerBytes, &header); err != nil {
		t.Fatal(err)
	}
	if header["alg"] != "EdDSA" || header["typ"] != "agent+jwt" {
		t.Fatalf("unexpected JWT header: %#v", header)
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		t.Fatal(err)
	}
	var claims agentClaims
	if err := json.Unmarshal(payload, &claims); err != nil {
		t.Fatal(err)
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[2])
	if err != nil {
		t.Fatal(err)
	}
	public, err := decodePublicKey(config.PublicKey)
	if err != nil {
		t.Fatal(err)
	}
	if !ed25519.Verify(public, []byte(parts[0]+"."+parts[1]), signature) {
		t.Fatal("JWT signature verification failed")
	}
	return claims
}

func TestLoadConfigRequiresPrivateRegularIdentity(t *testing.T) {
	config := configFixture(t)
	contents, err := json.Marshal(config)
	if err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(t.TempDir(), "agent.json")
	if err := os.WriteFile(path, contents, 0o600); err != nil {
		t.Fatal(err)
	}
	loaded, err := LoadConfig(path)
	if err != nil {
		t.Fatal(err)
	}
	if loaded.AgentID != config.AgentID || loaded.privateKey == nil {
		t.Fatalf("loaded identity is incomplete: %#v", loaded)
	}
	if err := os.Chmod(path, 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(path); !errors.Is(err, ErrConfigPermissions) {
		t.Fatalf("LoadConfig() error = %v, want permissions error", err)
	}
	link := filepath.Join(t.TempDir(), "agent-link.json")
	if err := os.Symlink(path, link); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(link); !errors.Is(err, ErrConfigPermissions) {
		t.Fatalf("LoadConfig(symlink) error = %v, want permissions error", err)
	}
}

func TestConfigRejectsEndpointAndKeySubstitution(t *testing.T) {
	config := configFixture(t)
	config.DefaultLocation = "https://attacker.test/api/auth/capability/execute"
	if _, err := NewClient(config, roundTripFunc(nil)); !errors.Is(err, ErrConfigInvalid) {
		t.Fatalf("NewClient(endpoint) error = %v", err)
	}

	config = configFixture(t)
	config.PublicKey.X = base64.RawURLEncoding.EncodeToString(make([]byte, ed25519.PublicKeySize))
	if _, err := NewClient(config, roundTripFunc(nil)); !errors.Is(err, ErrConfigInvalid) {
		t.Fatalf("NewClient(key) error = %v", err)
	}
}

func TestClientRotatesVerifiedAgentJWTForEveryProtocolRequest(t *testing.T) {
	config := configFixture(t)
	fixedNow := time.Date(2026, 9, 7, 1, 2, 3, 0, time.UTC)
	var mutex sync.Mutex
	var requests []*http.Request
	transport := roundTripFunc(func(request *http.Request) (*http.Response, error) {
		mutex.Lock()
		requests = append(requests, request.Clone(request.Context()))
		mutex.Unlock()
		return response(http.StatusOK, `{"success":true,"data":[]}`), nil
	})
	client, err := NewClient(config, transport)
	if err != nil {
		t.Fatal(err)
	}
	client.now = func() time.Time { return fixedNow }

	if _, err := client.ExecuteCapability(context.Background(), "task.execute", map[string]any{
		"action": "claim",
	}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.Heartbeat(context.Background(), map[string]any{"labels": []string{"task:execute"}}); err != nil {
		t.Fatal(err)
	}
	if _, err := client.DiscoverTasks(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(requests) != 3 {
		t.Fatalf("request count = %d", len(requests))
	}

	jwtIDs := map[string]bool{}
	for index, request := range requests {
		if request.Header.Get("Accept") != "application/json" {
			t.Fatalf("request %d Accept is missing", index)
		}
		token := strings.TrimPrefix(request.Header.Get("Authorization"), "Bearer ")
		claims := decodeAndVerifyJWT(t, token, config)
		if claims.Issuer != config.HostID || claims.Subject != config.AgentID ||
			claims.Audience != config.DefaultLocation || claims.ExpiresAt-claims.IssuedAt != 45 {
			t.Fatalf("request %d claims are invalid: %#v", index, claims)
		}
		if jwtIDs[claims.JWTID] {
			t.Fatalf("request %d reused jti %q", index, claims.JWTID)
		}
		if index > 0 && (len(claims.Capabilities) != 1 || claims.Capabilities[0] != TaskExecutionCapability) {
			t.Fatalf("request %d capabilities = %#v, want task.execute only", index, claims.Capabilities)
		}
		jwtIDs[claims.JWTID] = true
	}
	if requests[0].URL.Path != "/api/auth/capability/execute" || requests[0].Method != http.MethodPost {
		t.Fatalf("execute request = %s %s", requests[0].Method, requests[0].URL.Path)
	}
	if requests[1].URL.Path != "/api/v1/agent/host/heartbeat" || requests[1].Method != http.MethodPost {
		t.Fatalf("heartbeat request = %s %s", requests[1].Method, requests[1].URL.Path)
	}
	if requests[2].URL.Path != "/api/v1/agent/tasks/claimable" || requests[2].Method != http.MethodGet {
		t.Fatalf("discovery request = %s %s", requests[2].Method, requests[2].URL.Path)
	}
}

func TestNewHeartbeatReportValidatesHarnessAndLabels(t *testing.T) {
	report, err := NewHeartbeatReport(Harness{
		Kind:       "claude-code",
		Version:    "2.0.0",
		InstanceID: "local-1",
	}, []string{"task:execute", "linux:arm64", "task:execute"})
	if err != nil {
		t.Fatal(err)
	}
	if len(report.Harnesses) != 1 || report.Harnesses[0].Kind != "claude-code" {
		t.Fatalf("harnesses = %#v", report.Harnesses)
	}
	if len(report.Labels) != 2 || report.Labels[0] != "task:execute" || report.Labels[1] != "linux:arm64" {
		t.Fatalf("labels = %#v", report.Labels)
	}
	for _, fixture := range []Harness{{Kind: "unknown"}, {Kind: "codex", Version: strings.Repeat("x", 101)}} {
		if _, err := NewHeartbeatReport(fixture, nil); !errors.Is(err, ErrConfigInvalid) {
			t.Fatalf("NewHeartbeatReport(%#v) error = %v", fixture, err)
		}
	}
	if _, err := NewHeartbeatReport(Harness{Kind: "codex"}, []string{"INVALID LABEL"}); !errors.Is(err, ErrConfigInvalid) {
		t.Fatalf("invalid label error = %v", err)
	}
}

func TestClientFailsClosedForCapabilitiesAndRemoteErrors(t *testing.T) {
	config := configFixture(t)
	client, err := NewClient(config, roundTripFunc(func(_ *http.Request) (*http.Response, error) {
		return response(http.StatusForbidden, `{"error_code":"AGENT_GRANT_REVOKED","detail":"secret"}`), nil
	}))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ExecuteCapability(context.Background(), "document.edit", nil); !errors.Is(err, ErrCapabilityDenied) {
		t.Fatalf("unrequested capability error = %v", err)
	}
	_, err = client.ExecuteCapability(context.Background(), "task.execute", nil)
	var protocolError *ProtocolError
	if !errors.As(err, &protocolError) || protocolError.Code != "AGENT_GRANT_REVOKED" ||
		protocolError.Status != http.StatusForbidden {
		t.Fatalf("remote error = %#v", err)
	}
	if strings.Contains(err.Error(), "secret") {
		t.Fatalf("remote error leaked response details: %v", err)
	}
}
