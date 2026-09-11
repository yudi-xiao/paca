// Package agentauth implements the Better Auth Agent Auth protocol used by
// Paca's Worker control plane. It deliberately owns no business permissions:
// every request is authorized again by the active server-side Grant.
package agentauth

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"
)

const maxConfigBytes = 64 * 1024

// JWK is the minimal Ed25519 JSON Web Key representation stored in a private
// Agent identity file.
type JWK struct {
	KTY    string   `json:"kty"`
	CRV    string   `json:"crv"`
	X      string   `json:"x"`
	D      string   `json:"d,omitempty"`
	Alg    string   `json:"alg,omitempty"`
	Use    string   `json:"use,omitempty"`
	KID    string   `json:"kid,omitempty"`
	Ext    bool     `json:"ext,omitempty"`
	KeyOps []string `json:"key_ops,omitempty"`
}

// GrantRequest records one capability and its server-approved constraints as
// returned during Agent enrollment.
type GrantRequest struct {
	Capability  string         `json:"capability"`
	Constraints map[string]any `json:"constraints"`
}

// Config is the versioned private identity written by the Worker-side Agent
// registration CLI. PrivateKey is never serialized in logs or protocol errors.
type Config struct {
	Version         int            `json:"version"`
	ProviderOrigin  string         `json:"providerOrigin"`
	Issuer          string         `json:"issuer"`
	DefaultLocation string         `json:"defaultLocation"`
	HostID          string         `json:"hostId"`
	AgentID         string         `json:"agentId"`
	AgentName       string         `json:"agentName"`
	KeyAlgorithm    string         `json:"keyAlgorithm"`
	PublicKey       JWK            `json:"publicKey"`
	PrivateKey      JWK            `json:"privateKey"`
	Capabilities    []string       `json:"capabilities"`
	GrantRequests   []GrantRequest `json:"grantRequests,omitempty"`
	RegisteredAt    string         `json:"registeredAt"`

	privateKey ed25519.PrivateKey
}

var (
	// ErrConfigInvalid indicates malformed or internally inconsistent Agent
	// identity configuration.
	ErrConfigInvalid = errors.New("agentauth: config invalid")
	// ErrConfigPermissions indicates that the private identity file is not
	// protected by the required owner-only filesystem permissions.
	ErrConfigPermissions = errors.New("agentauth: config permissions invalid")
	// ErrCapabilityDenied indicates an attempt to request a capability absent
	// from the enrolled identity.
	ErrCapabilityDenied = errors.New("agentauth: capability not requested")
)

// LoadConfig rejects symlinks, non-regular files and group/world-readable
// identity files before decoding. This keeps the private Agent key boundary the
// same as the TypeScript enrollment CLI's 0600 contract.
func LoadConfig(path string) (*Config, error) {
	info, err := os.Lstat(path)
	if err != nil {
		return nil, fmt.Errorf("%w: read identity", ErrConfigInvalid)
	}
	if !info.Mode().IsRegular() || info.Mode().Perm()&0o077 != 0 {
		return nil, ErrConfigPermissions
	}
	file, err := os.Open(path)
	if err != nil {
		return nil, fmt.Errorf("%w: open identity", ErrConfigInvalid)
	}
	contents, readErr := io.ReadAll(io.LimitReader(file, maxConfigBytes+1))
	closeErr := file.Close()
	if readErr != nil || closeErr != nil || len(contents) > maxConfigBytes {
		return nil, fmt.Errorf("%w: identity size", ErrConfigInvalid)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	var config Config
	if err := decoder.Decode(&config); err != nil {
		return nil, fmt.Errorf("%w: identity json", ErrConfigInvalid)
	}
	if err := ensureJSONEnd(decoder); err != nil {
		return nil, err
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	return &config, nil
}

func ensureJSONEnd(decoder *json.Decoder) error {
	var trailing any
	if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
		return fmt.Errorf("%w: trailing identity data", ErrConfigInvalid)
	}
	return nil
}

func (config *Config) validate() error {
	if config.Version != 1 || config.KeyAlgorithm != "Ed25519" {
		return ErrConfigInvalid
	}
	origin, err := canonicalOrigin(config.ProviderOrigin)
	if err != nil || origin != config.ProviderOrigin {
		return ErrConfigInvalid
	}
	if !exactEndpoint(config.Issuer, origin, "/api/auth") ||
		!exactEndpoint(config.DefaultLocation, origin, "/api/auth/capability/execute") {
		return ErrConfigInvalid
	}
	if strings.TrimSpace(config.HostID) == "" || strings.TrimSpace(config.AgentID) == "" ||
		strings.TrimSpace(config.AgentName) == "" {
		return ErrConfigInvalid
	}
	if _, err := time.Parse(time.RFC3339, config.RegisteredAt); err != nil {
		return ErrConfigInvalid
	}
	if len(config.Capabilities) == 0 || len(config.Capabilities) > 64 {
		return ErrConfigInvalid
	}
	seen := make(map[string]struct{}, len(config.Capabilities))
	for _, capability := range config.Capabilities {
		if strings.TrimSpace(capability) != capability || capability == "" || len(capability) > 128 {
			return ErrConfigInvalid
		}
		if _, duplicate := seen[capability]; duplicate {
			return ErrConfigInvalid
		}
		seen[capability] = struct{}{}
	}

	public, err := decodePublicKey(config.PublicKey)
	if err != nil {
		return ErrConfigInvalid
	}
	seed, err := base64.RawURLEncoding.DecodeString(config.PrivateKey.D)
	if err != nil || len(seed) != ed25519.SeedSize || config.PrivateKey.KTY != "OKP" ||
		config.PrivateKey.CRV != "Ed25519" || !validJWKMetadata(config.PrivateKey, "sign") {
		return ErrConfigInvalid
	}
	privateKey := ed25519.NewKeyFromSeed(seed)
	if !bytes.Equal(public, privateKey.Public().(ed25519.PublicKey)) {
		return ErrConfigInvalid
	}
	privatePublic, err := base64.RawURLEncoding.DecodeString(config.PrivateKey.X)
	if err != nil || !bytes.Equal(privatePublic, public) {
		return ErrConfigInvalid
	}
	if config.PublicKey.KID != "" && config.PrivateKey.KID != "" &&
		config.PublicKey.KID != config.PrivateKey.KID {
		return ErrConfigInvalid
	}
	config.privateKey = privateKey
	return nil
}

func decodePublicKey(jwk JWK) (ed25519.PublicKey, error) {
	if jwk.KTY != "OKP" || jwk.CRV != "Ed25519" || jwk.X == "" || jwk.D != "" ||
		!validJWKMetadata(jwk, "verify") {
		return nil, ErrConfigInvalid
	}
	decoded, err := base64.RawURLEncoding.DecodeString(jwk.X)
	if err != nil || len(decoded) != ed25519.PublicKeySize {
		return nil, ErrConfigInvalid
	}
	return ed25519.PublicKey(decoded), nil
}

func validJWKMetadata(jwk JWK, operation string) bool {
	if (jwk.Alg != "" && jwk.Alg != "EdDSA") || (jwk.Use != "" && jwk.Use != "sig") {
		return false
	}
	return len(jwk.KeyOps) == 0 || (len(jwk.KeyOps) == 1 && jwk.KeyOps[0] == operation)
}

func canonicalOrigin(value string) (string, error) {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.User != nil ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" {
		return "", ErrConfigInvalid
	}
	return parsed.Scheme + "://" + parsed.Host, nil
}

func exactEndpoint(value, origin, path string) bool {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme+"://"+parsed.Host != origin {
		return false
	}
	return parsed.User == nil && parsed.Path == path && parsed.RawQuery == "" && parsed.Fragment == ""
}

func (config *Config) requestsCapability(capability string) bool {
	for _, requested := range config.Capabilities {
		if requested == capability {
			return true
		}
	}
	return false
}

// HasCapability reports whether the immutable registration config requested a
// capability. It is only a local preflight check; the Worker remains the
// authority for active Grant state and constraints on every request.
func (config *Config) HasCapability(capability string) bool {
	return config != nil && config.requestsCapability(capability)
}
