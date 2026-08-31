package main

import (
	"strings"
	"testing"

	"github.com/google/uuid"
)

func baseEnvironment(t *testing.T) {
	t.Helper()
	t.Setenv("LEGACY_DATABASE_URL", "postgresql://legacy.invalid/paca")
	t.Setenv("DATABASE_URL", "postgresql://target.invalid/paca")
	t.Setenv("R2_BUCKET", "paca-attachments-internal")
	t.Setenv("PACA_ATTACHMENT_MIGRATION_COMMAND", "")
	t.Setenv("PACA_ATTACHMENT_MIGRATION_RUN_ID", "")
	t.Setenv("PACA_ATTACHMENT_ORPHAN_BEFORE", "")
}

func TestLoadConfigDefaultsToReadOnlyPreview(t *testing.T) {
	baseEnvironment(t)
	cfg, err := loadConfig()
	if err != nil {
		t.Fatalf("load preview config: %v", err)
	}
	if cfg.command != "preview" || cfg.runID == uuid.Nil || cfg.pageSize != 100 {
		t.Fatalf("unsafe preview defaults: %+v", cfg)
	}
}

func TestMutationConfirmationMustExactlyMatchRunID(t *testing.T) {
	runID := uuid.MustParse("db217b8c-0542-4b96-bc26-febd9d10a388")
	t.Setenv("PACA_ATTACHMENT_MIGRATION_APPLY", "wrong")
	if err := requireConfirmation("PACA_ATTACHMENT_MIGRATION_APPLY", runID); err == nil {
		t.Fatal("mismatched confirmation was accepted")
	}
	t.Setenv("PACA_ATTACHMENT_MIGRATION_APPLY", runID.String())
	if err := requireConfirmation("PACA_ATTACHMENT_MIGRATION_APPLY", runID); err != nil {
		t.Fatalf("exact confirmation was rejected: %v", err)
	}
}

func TestOrphanDeleteRequiresExplicitCutoff(t *testing.T) {
	baseEnvironment(t)
	t.Setenv("PACA_ATTACHMENT_MIGRATION_COMMAND", "orphan-delete")
	t.Setenv("R2_S3_ENDPOINT", "https://account-id.r2.cloudflarestorage.com")
	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "PACA_ATTACHMENT_ORPHAN_BEFORE") {
		t.Fatalf("missing deletion cutoff was accepted: %v", err)
	}
}

func TestLoadConfigRejectsInvalidBooleanInsteadOfFallingBack(t *testing.T) {
	baseEnvironment(t)
	t.Setenv("PACA_ATTACHMENT_MIGRATION_COMMAND", "apply")
	t.Setenv("PACA_ATTACHMENT_MIGRATION_RUN_ID", uuid.NewString())
	t.Setenv("LEGACY_S3_FORCE_PATH_STYLE", "definitely")
	_, err := loadConfig()
	if err == nil || !strings.Contains(err.Error(), "LEGACY_S3_FORCE_PATH_STYLE") {
		t.Fatalf("invalid boolean was silently accepted: %v", err)
	}
}

func TestLoadConfigRejectsNonCloudflareOrInsecureR2Endpoint(t *testing.T) {
	baseEnvironment(t)
	t.Setenv("PACA_ATTACHMENT_MIGRATION_COMMAND", "verify")
	t.Setenv("PACA_ATTACHMENT_MIGRATION_RUN_ID", uuid.NewString())
	for _, endpoint := range []string{
		"http://account.r2.cloudflarestorage.com",
		"https://example.invalid",
		"https://account.r2.cloudflarestorage.com/path",
	} {
		t.Setenv("R2_S3_ENDPOINT", endpoint)
		if _, err := loadConfig(); err == nil || !strings.Contains(err.Error(), "Cloudflare R2") {
			t.Fatalf("unsafe R2 endpoint %q was accepted: %v", endpoint, err)
		}
	}

	t.Setenv("R2_S3_ENDPOINT", "https://account-id.r2.cloudflarestorage.com")
	if _, err := loadConfig(); err != nil {
		t.Fatalf("valid R2 endpoint was rejected: %v", err)
	}
}
