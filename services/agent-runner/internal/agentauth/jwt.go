package agentauth

import (
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
)

const agentJWTLifetime = 45 * time.Second

type agentClaims struct {
	Capabilities []string `json:"capabilities"`
	Issuer       string   `json:"iss"`
	Subject      string   `json:"sub"`
	Audience     string   `json:"aud"`
	JWTID        string   `json:"jti"`
	IssuedAt     int64    `json:"iat"`
	ExpiresAt    int64    `json:"exp"`
}

func (config *Config) signAgentJWT(capabilities []string, now time.Time) (string, error) {
	if len(capabilities) == 0 || len(capabilities) > len(config.Capabilities) {
		return "", ErrCapabilityDenied
	}
	seen := make(map[string]struct{}, len(capabilities))
	for _, capability := range capabilities {
		if !config.requestsCapability(capability) {
			return "", ErrCapabilityDenied
		}
		if _, duplicate := seen[capability]; duplicate {
			return "", ErrCapabilityDenied
		}
		seen[capability] = struct{}{}
	}
	header, err := encodeJWTPart(map[string]string{"alg": "EdDSA", "typ": "agent+jwt"})
	if err != nil {
		return "", fmt.Errorf("agentauth: encode jwt header: %w", err)
	}
	issuedAt := now.UTC().Truncate(time.Second)
	payload, err := encodeJWTPart(agentClaims{
		Capabilities: capabilities,
		Issuer:       config.HostID,
		Subject:      config.AgentID,
		Audience:     config.DefaultLocation,
		JWTID:        uuid.NewString(),
		IssuedAt:     issuedAt.Unix(),
		ExpiresAt:    issuedAt.Add(agentJWTLifetime).Unix(),
	})
	if err != nil {
		return "", fmt.Errorf("agentauth: encode jwt claims: %w", err)
	}
	unsigned := header + "." + payload
	signature := ed25519.Sign(config.privateKey, []byte(unsigned))
	return strings.Join([]string{unsigned, base64.RawURLEncoding.EncodeToString(signature)}, "."), nil
}

func encodeJWTPart(value any) (string, error) {
	encoded, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}
