// Package capabilitybroker exposes a narrow, short-lived bridge from an
// untrusted Agent sandbox to Paca's Better Auth Agent Auth control plane.
// The Agent's Ed25519 private key never enters the sandbox: agent-runner
// retains it and signs a fresh Agent JWT for every accepted broker request.
package capabilitybroker

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"

	"github.com/Paca-AI/agent-runner/internal/agentauth"
)

const (
	maxRequestBytes = 1024 * 1024
	// A normal Agent turn is bounded at 30 minutes. Give a newly started
	// sandbox enough time to reason before its first tool call, then refresh
	// only while it actively uses the broker. Teardown revokes immediately.
	sessionIdleTTL = 45 * time.Minute
)

var (
	// ErrConfigInvalid indicates an invalid broker identity, request scope or
	// session configuration.
	ErrConfigInvalid = errors.New("capabilitybroker: config invalid")
	// ErrScopeUnavailable indicates that no active, Project-scoped capability
	// may be delegated into the sandbox.
	ErrScopeUnavailable = errors.New("capabilitybroker: no Project-scoped capability available")
)

type agentClient interface {
	ExecuteCapability(context.Context, string, map[string]any) (json.RawMessage, error)
	RequestAgent(context.Context, string, string, []string, []byte) (json.RawMessage, error)
}

type publicConfig struct {
	Version       int                      `json:"version"`
	AgentID       string                   `json:"agentId"`
	ProjectID     string                   `json:"projectId"`
	Capabilities  []string                 `json:"capabilities"`
	GrantRequests []agentauth.GrantRequest `json:"grantRequests"`
}

// Session is injected into one sandbox process. Config is public metadata,
// not an Agent identity: it contains no Host key, Agent key, JWT, or provider
// endpoint. Token is an opaque 256-bit bearer held only for this session.
type Session struct {
	Token         string
	EncodedConfig string
}

type sessionRecord struct {
	projectID    string
	capabilities map[string]struct{}
	expiresAt    time.Time
}

// Broker owns only process-local, bounded session state. A Runner restart
// invalidates every token, which is safer than attempting to persist sandbox
// credentials. The underlying Agent Auth client remains the source of fresh
// JWTs and the Worker remains authoritative for active Grant constraints.
type Broker struct {
	client   agentClient
	identity *agentauth.Config
	now      func() time.Time
	mu       sync.Mutex
	sessions map[[sha256.Size]byte]sessionRecord
}

// New constructs an in-process broker bound to exactly one enrolled Agent
// identity.
func New(client agentClient, identity *agentauth.Config) (*Broker, error) {
	if client == nil || identity == nil || strings.TrimSpace(identity.AgentID) == "" {
		return nil, ErrConfigInvalid
	}
	return &Broker{
		client:   client,
		identity: identity,
		now:      time.Now,
		sessions: make(map[[sha256.Size]byte]sessionRecord),
	}, nil
}

// Manages reports whether this broker owns the configured Agent identity.
// Other Agents may continue on the legacy path during a staged rollout.
func (broker *Broker) Manages(agentID string) bool {
	return broker != nil && agentID == broker.identity.AgentID
}

func exactString(value any) string {
	switch typed := value.(type) {
	case string:
		return typed
	case map[string]any:
		if len(typed) == 1 {
			value, _ := typed["eq"].(string)
			return value
		}
	}
	return ""
}

func (broker *Broker) projectGrants(projectID string, now time.Time) []agentauth.GrantRequest {
	requests := make([]agentauth.GrantRequest, 0, len(broker.identity.GrantRequests))
	for _, request := range broker.identity.GrantRequests {
		// task.execute stays in agent-runner's lease coordinator and
		// environment.connect returns another bearer credential. Neither is
		// delegated into the untrusted sandbox by this first broker contract.
		if request.Capability == agentauth.TaskExecutionCapability || request.Capability == "environment.connect" ||
			!broker.identity.HasCapability(request.Capability) ||
			exactString(request.Constraints["projectId"]) != projectID {
			continue
		}
		validUntil, err := time.Parse(time.RFC3339, exactString(request.Constraints["validUntil"]))
		if err != nil || !validUntil.After(now) {
			continue
		}
		requests = append(requests, request)
	}
	return requests
}

// Issue creates one Project-scoped sandbox session for the configured Agent.
// conversationID is validated even though it is not exposed to the sandbox;
// callers cannot accidentally use this broker as a global Agent credential.
func (broker *Broker) Issue(agentID, conversationID, projectID string) (Session, error) {
	conversationUUID, conversationErr := uuid.Parse(conversationID)
	projectUUID, projectErr := uuid.Parse(projectID)
	if agentID != broker.identity.AgentID || conversationErr != nil || projectErr != nil ||
		conversationUUID == uuid.Nil || projectUUID == uuid.Nil {
		return Session{}, ErrConfigInvalid
	}
	now := broker.now()
	requests := broker.projectGrants(projectID, now)
	if len(requests) == 0 {
		return Session{}, ErrScopeUnavailable
	}
	capabilities := make([]string, 0, len(requests))
	allowed := make(map[string]struct{}, len(requests))
	for _, request := range requests {
		if _, exists := allowed[request.Capability]; exists {
			continue
		}
		allowed[request.Capability] = struct{}{}
		capabilities = append(capabilities, request.Capability)
	}
	config, err := json.Marshal(publicConfig{
		Version:       1,
		AgentID:       agentID,
		ProjectID:     projectID,
		Capabilities:  capabilities,
		GrantRequests: requests,
	})
	if err != nil || len(config) > 64*1024 {
		return Session{}, ErrConfigInvalid
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return Session{}, ErrConfigInvalid
	}
	token := base64.RawURLEncoding.EncodeToString(secret)
	key := sha256.Sum256([]byte(token))

	broker.mu.Lock()
	broker.purgeExpiredLocked(now)
	broker.sessions[key] = sessionRecord{
		projectID:    projectID,
		capabilities: allowed,
		expiresAt:    now.Add(sessionIdleTTL),
	}
	broker.mu.Unlock()

	return Session{Token: token, EncodedConfig: base64.RawURLEncoding.EncodeToString(config)}, nil
}

// Revoke invalidates a sandbox session immediately. It is safe to call more
// than once and never logs or returns the bearer.
func (broker *Broker) Revoke(token string) {
	if token == "" {
		return
	}
	key := sha256.Sum256([]byte(token))
	broker.mu.Lock()
	delete(broker.sessions, key)
	broker.mu.Unlock()
}

func (broker *Broker) purgeExpiredLocked(now time.Time) {
	for key, session := range broker.sessions {
		if !session.expiresAt.After(now) {
			delete(broker.sessions, key)
		}
	}
}

func (broker *Broker) authorize(token string) (sessionRecord, bool) {
	if len(token) != 43 {
		return sessionRecord{}, false
	}
	key := sha256.Sum256([]byte(token))
	now := broker.now()
	broker.mu.Lock()
	defer broker.mu.Unlock()
	broker.purgeExpiredLocked(now)
	session, ok := broker.sessions[key]
	if !ok {
		return sessionRecord{}, false
	}
	// Sliding idle expiry supports a long-running turn without making a
	// stolen, unused token durable. Teardown still revokes it immediately.
	session.expiresAt = now.Add(sessionIdleTTL)
	broker.sessions[key] = session
	return session, true
}

type brokerRequest struct {
	Operation    string          `json:"operation"`
	Capability   string          `json:"capability,omitempty"`
	Arguments    json.RawMessage `json:"arguments,omitempty"`
	Method       string          `json:"method,omitempty"`
	Path         string          `json:"path,omitempty"`
	Capabilities []string        `json:"capabilities,omitempty"`
	Body         json.RawMessage `json:"body,omitempty"`
}

func bearer(request *http.Request) string {
	const prefix = "Bearer "
	value := request.Header.Get("Authorization")
	if !strings.HasPrefix(value, prefix) || strings.Contains(value[len(prefix):], " ") {
		return ""
	}
	return value[len(prefix):]
}

func projectArgument(raw json.RawMessage) (map[string]any, string, bool) {
	var arguments map[string]any
	decoder := json.NewDecoder(strings.NewReader(string(raw)))
	decoder.UseNumber()
	if err := decoder.Decode(&arguments); err != nil || arguments == nil {
		return nil, "", false
	}
	projectID, ok := arguments["projectId"].(string)
	return arguments, projectID, ok
}

func allowedCapabilities(session sessionRecord, capabilities []string) bool {
	if len(capabilities) == 0 || len(capabilities) > 8 {
		return false
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if _, ok := session.capabilities[capability]; !ok {
			return false
		}
		if _, duplicate := seen[capability]; duplicate {
			return false
		}
		seen[capability] = struct{}{}
	}
	return true
}

func allowedProjectPath(path, projectID string) bool {
	prefix := "/api/v1/agent/projects/" + projectID + "/"
	if !strings.HasPrefix(path, prefix) || strings.Contains(path, "//") ||
		strings.ContainsAny(path, "?#%") {
		return false
	}
	for _, segment := range strings.Split(path, "/") {
		if segment == "." || segment == ".." {
			return false
		}
	}
	return true
}

func writeError(response http.ResponseWriter, status int, code string) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(status)
	_ = json.NewEncoder(response).Encode(map[string]string{"code": code})
}

func writeUpstream(response http.ResponseWriter, result json.RawMessage) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("Content-Type", "application/json")
	response.WriteHeader(http.StatusOK)
	_, _ = response.Write(result)
}

func upstreamError(response http.ResponseWriter, err error) {
	var protocol *agentauth.ProtocolError
	if errors.As(err, &protocol) && protocol.Status >= 400 && protocol.Status <= 599 {
		writeError(response, protocol.Status, protocol.Code)
		return
	}
	writeError(response, http.StatusBadGateway, "CAPABILITY_BROKER_UPSTREAM_FAILED")
}

// ServeHTTP accepts only the broker's small JSON protocol. The caller's
// headers and target URL are never forwarded, preventing a sandbox from using
// the Runner as a generic authenticated proxy.
func (broker *Broker) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || strings.TrimSpace(strings.Split(request.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		writeError(response, http.StatusNotFound, "CAPABILITY_BROKER_ROUTE_NOT_FOUND")
		return
	}
	session, ok := broker.authorize(bearer(request))
	if !ok {
		writeError(response, http.StatusUnauthorized, "CAPABILITY_BROKER_UNAUTHORIZED")
		return
	}
	body, err := io.ReadAll(io.LimitReader(request.Body, maxRequestBytes+1))
	if err != nil || len(body) > maxRequestBytes {
		writeError(response, http.StatusBadRequest, "CAPABILITY_BROKER_REQUEST_INVALID")
		return
	}
	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var input brokerRequest
	if err := decoder.Decode(&input); err != nil {
		writeError(response, http.StatusBadRequest, "CAPABILITY_BROKER_REQUEST_INVALID")
		return
	}
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		writeError(response, http.StatusBadRequest, "CAPABILITY_BROKER_REQUEST_INVALID")
		return
	}

	switch input.Operation {
	case "execute":
		if len(input.Capabilities) != 0 || input.Method != "" || input.Path != "" || len(input.Body) != 0 ||
			!allowedCapabilities(session, []string{input.Capability}) {
			writeError(response, http.StatusForbidden, "CAPABILITY_BROKER_SCOPE_DENIED")
			return
		}
		arguments, projectID, valid := projectArgument(input.Arguments)
		if !valid || projectID != session.projectID {
			writeError(response, http.StatusForbidden, "CAPABILITY_BROKER_SCOPE_DENIED")
			return
		}
		result, err := broker.client.ExecuteCapability(request.Context(), input.Capability, arguments)
		if err != nil {
			upstreamError(response, err)
			return
		}
		writeUpstream(response, result)
	case "agent_request":
		if input.Capability != "" || len(input.Arguments) != 0 ||
			!allowedCapabilities(session, input.Capabilities) ||
			(input.Method != http.MethodGet && input.Method != http.MethodPost && input.Method != http.MethodDelete) ||
			!allowedProjectPath(input.Path, session.projectID) {
			writeError(response, http.StatusForbidden, "CAPABILITY_BROKER_SCOPE_DENIED")
			return
		}
		payload := []byte(nil)
		if len(input.Body) > 0 && string(input.Body) != "null" {
			if !json.Valid(input.Body) {
				writeError(response, http.StatusBadRequest, "CAPABILITY_BROKER_REQUEST_INVALID")
				return
			}
			payload = input.Body
		}
		result, err := broker.client.RequestAgent(
			request.Context(), input.Method, input.Path, input.Capabilities, payload,
		)
		if err != nil {
			upstreamError(response, err)
			return
		}
		writeUpstream(response, result)
	default:
		writeError(response, http.StatusBadRequest, "CAPABILITY_BROKER_REQUEST_INVALID")
	}
}
