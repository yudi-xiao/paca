package agentauth

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

const maxResponseBytes = 1024 * 1024

var remoteCodePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

type ProtocolError struct {
	Code   string
	Status int
}

func (err *ProtocolError) Error() string {
	return err.Code
}

// Client signs a fresh non-replayable Agent JWT for every request. It refuses
// redirects so an Authorization header can never be forwarded to another host.
type Client struct {
	config *Config
	http   *http.Client
	now    func() time.Time
}

func NewClient(config *Config, transport http.RoundTripper) (*Client, error) {
	if config == nil {
		return nil, ErrConfigInvalid
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	if transport == nil {
		transport = http.DefaultTransport
	}
	return &Client{
		config: config,
		http: &http.Client{
			Transport: transport,
			Timeout:   15 * time.Second,
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return errors.New("agentauth: redirect refused")
			},
		},
		now: time.Now,
	}, nil
}

func (client *Client) ExecuteCapability(
	ctx context.Context,
	capability string,
	arguments map[string]any,
) (json.RawMessage, error) {
	if !client.config.requestsCapability(capability) {
		return nil, ErrCapabilityDenied
	}
	payload, err := json.Marshal(map[string]any{
		"capability": capability,
		"arguments":  arguments,
	})
	if err != nil {
		return nil, fmt.Errorf("agentauth: encode capability request: %w", err)
	}
	return client.request(
		ctx,
		http.MethodPost,
		client.config.DefaultLocation,
		[]string{capability},
		payload,
	)
}

func (client *Client) discoverTasks(ctx context.Context) (json.RawMessage, error) {
	return client.agentRequest(
		ctx,
		http.MethodGet,
		"/api/v1/agent/tasks/claimable",
		[]string{TaskExecutionCapability},
		nil,
	)
}

func (client *Client) Heartbeat(ctx context.Context, report any) (json.RawMessage, error) {
	payload, err := json.Marshal(report)
	if err != nil {
		return nil, fmt.Errorf("agentauth: encode heartbeat: %w", err)
	}
	return client.agentRequest(
		ctx,
		http.MethodPost,
		"/api/v1/agent/host/heartbeat",
		[]string{TaskExecutionCapability},
		payload,
	)
}

func (client *Client) agentRequest(
	ctx context.Context,
	method string,
	path string,
	capabilities []string,
	payload []byte,
) (json.RawMessage, error) {
	if !strings.HasPrefix(path, "/api/v1/agent/") || strings.Contains(path, "//") {
		return nil, ErrConfigInvalid
	}
	target, err := url.Parse(client.config.ProviderOrigin)
	if err != nil {
		return nil, ErrConfigInvalid
	}
	target.Path = path
	return client.request(ctx, method, target.String(), capabilities, payload)
}

// RequestAgent calls one versioned Paca Agent API route with a fresh Agent
// JWT. It is exported for the local Capability Broker, which keeps the
// private Agent key in agent-runner while forwarding a narrowly scoped
// request from an untrusted sandbox. The broker applies its own Project and
// capability allow-list before this method is reached; this method still
// rejects malformed paths and capabilities absent from the enrolled identity.
func (client *Client) RequestAgent(
	ctx context.Context,
	method string,
	path string,
	capabilities []string,
	payload []byte,
) (json.RawMessage, error) {
	switch method {
	case http.MethodGet, http.MethodPost, http.MethodDelete:
	default:
		return nil, ErrConfigInvalid
	}
	if len(capabilities) == 0 || len(capabilities) > 8 {
		return nil, ErrCapabilityDenied
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if !client.config.requestsCapability(capability) {
			return nil, ErrCapabilityDenied
		}
		if _, duplicate := seen[capability]; duplicate {
			return nil, ErrCapabilityDenied
		}
		seen[capability] = struct{}{}
	}
	return client.agentRequest(ctx, method, path, capabilities, payload)
}

func (client *Client) request(
	ctx context.Context,
	method string,
	target string,
	capabilities []string,
	payload []byte,
) (json.RawMessage, error) {
	token, err := client.config.signAgentJWT(capabilities, client.now())
	if err != nil {
		return nil, err
	}
	request, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(payload))
	if err != nil {
		return nil, fmt.Errorf("agentauth: create request: %w", err)
	}
	request.Header.Set("Accept", "application/json")
	request.Header.Set("Authorization", "Bearer "+token)
	if payload != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	response, err := client.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("agentauth: request failed: %w", err)
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, maxResponseBytes+1))
	if err != nil || len(body) > maxResponseBytes {
		return nil, &ProtocolError{Code: "AGENT_RESPONSE_INVALID", Status: response.StatusCode}
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, &ProtocolError{Code: remoteErrorCode(body, response.StatusCode), Status: response.StatusCode}
	}
	if !json.Valid(body) {
		return nil, &ProtocolError{Code: "AGENT_RESPONSE_INVALID", Status: response.StatusCode}
	}
	return json.RawMessage(body), nil
}

func remoteErrorCode(body []byte, status int) string {
	var response struct {
		Code      string `json:"code"`
		Error     string `json:"error"`
		ErrorCode string `json:"error_code"`
	}
	if json.Unmarshal(body, &response) == nil {
		for _, code := range []string{response.Code, response.ErrorCode, response.Error} {
			if remoteCodePattern.MatchString(code) {
				return code
			}
		}
	}
	return fmt.Sprintf("AGENT_HTTP_%d", status)
}
