package authz_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"

	"github.com/Paca-AI/api/internal/platform/authz"
)

type shadowDecisionCorpus struct {
	Version int                  `json:"version"`
	Cases   []shadowDecisionCase `json:"cases"`
}

type shadowDecisionCase struct {
	Name          string     `json:"name"`
	Actor         string     `json:"actor"`
	Scope         string     `json:"scope"`
	ProjectMember bool       `json:"projectMember"`
	GrantSets     [][]string `json:"grantSets"`
	Required      []string   `json:"required"`
	Allowed       bool       `json:"allowed"`
}

func loadShadowDecisionCorpus(t *testing.T) shadowDecisionCorpus {
	t.Helper()
	path := filepath.Join("..", "..", "..", "testdata", "authorization-shadow-decisions.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read authorization shadow corpus: %v", err)
	}
	var corpus shadowDecisionCorpus
	if err := json.Unmarshal(contents, &corpus); err != nil {
		t.Fatalf("decode authorization shadow corpus: %v", err)
	}
	if corpus.Version != 1 || len(corpus.Cases) == 0 {
		t.Fatalf("unexpected authorization shadow corpus: version=%d cases=%d", corpus.Version, len(corpus.Cases))
	}
	return corpus
}

func TestAuthorizer_SharedShadowDecisionCorpus(t *testing.T) {
	corpus := loadShadowDecisionCorpus(t)
	seenNames := map[string]struct{}{}

	for _, decision := range corpus.Cases {
		decision := decision
		t.Run(decision.Name, func(t *testing.T) {
			if _, exists := seenNames[decision.Name]; exists || decision.Name == "" {
				t.Fatalf("duplicate or empty case name %q", decision.Name)
			}
			seenNames[decision.Name] = struct{}{}

			granted := make([]authz.Permission, 0)
			for _, grantSet := range decision.GrantSets {
				for _, grant := range grantSet {
					granted = append(granted, authz.Permission(grant))
				}
			}
			required := make([]authz.Permission, 0, len(decision.Required))
			for _, permission := range decision.Required {
				required = append(required, authz.Permission(permission))
			}

			var allowed bool
			var err error
			switch decision.Actor {
			case "user":
				store := &stubPermissionStore{}
				var projectID *uuid.UUID
				switch decision.Scope {
				case "global":
					store.globalPerms = granted
				case "project":
					store.projectPerms = granted
					id := uuid.New()
					projectID = &id
				default:
					t.Fatalf("unsupported scope %q", decision.Scope)
				}
				allowed, err = authz.NewAuthorizer(store).HasPermissions(
					context.Background(),
					uuid.New(),
					projectID,
					required...,
				)
			case "legacy_agent":
				if decision.Scope != "project" {
					t.Fatalf("legacy Agent corpus case must be project-scoped")
				}
				agentID := uuid.New()
				projectID := uuid.New()
				store := &mockPermissionStore{
					agentPerms: map[uuid.UUID]map[uuid.UUID][]authz.Permission{
						projectID: {agentID: granted},
					},
				}
				resolver := &mockAgentRoleResolver{roles: map[uuid.UUID]map[uuid.UUID]string{}}
				if decision.ProjectMember {
					resolver.roles[projectID] = map[uuid.UUID]string{agentID: "shadow-role"}
				}
				allowed, err = authz.NewAuthorizer(store).
					WithAgentRoleResolver(resolver).
					HasPermissionsForAgent(context.Background(), agentID, projectID, required...)
			default:
				t.Fatalf("unsupported actor %q", decision.Actor)
			}
			if err != nil {
				t.Fatalf("evaluate shared decision: %v", err)
			}
			if allowed != decision.Allowed {
				t.Fatalf("decision mismatch: want allowed=%t got %t", decision.Allowed, allowed)
			}
		})
	}
}
