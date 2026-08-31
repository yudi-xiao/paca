package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Paca-AI/api/internal/platform/attachmentmigration"
	"github.com/Paca-AI/api/internal/platform/database"
	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

type config struct {
	command       string
	runID         uuid.UUID
	pageSize      int
	sourceDBURL   string
	targetDBURL   string
	targetBucket  string
	tempDirectory string
	orphanBefore  time.Time
	sourceS3      attachmentmigration.S3EndpointConfig
	targetS3      attachmentmigration.S3EndpointConfig
}

func main() {
	if err := run(context.Background()); err != nil {
		writeJSON(map[string]any{"status": "error", "error": err.Error()})
		os.Exit(1)
	}
}

func run(ctx context.Context) error {
	cfg, err := loadConfig()
	if err != nil {
		return err
	}
	logger := slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))
	var sourceDB *sqlx.DB
	if commandNeedsSourceDatabase(cfg.command) {
		sourceDB, err = database.Open(database.Config{DSN: cfg.sourceDBURL}, logger)
		if err != nil {
			return fmt.Errorf("attachment migration command: connect source database: %w", err)
		}
		defer func() { _ = sourceDB.Close() }()
	}
	targetDB, err := database.Open(database.Config{DSN: cfg.targetDBURL}, logger)
	if err != nil {
		return fmt.Errorf("attachment migration command: connect target database: %w", err)
	}
	defer func() { _ = targetDB.Close() }()

	repository := attachmentmigration.NewPostgresRepository(sourceDB, targetDB, cfg.targetBucket)
	var objects attachmentmigration.ObjectStore
	if cfg.command == "apply" {
		objects, err = attachmentmigration.NewMigrationObjectStore(
			ctx,
			cfg.sourceS3,
			cfg.targetS3,
			cfg.targetBucket,
			cfg.tempDirectory,
		)
	} else if cfg.command == "verify" || cfg.command == "rollback" ||
		cfg.command == "orphan-audit" || cfg.command == "orphan-delete" {
		objects, err = attachmentmigration.NewTargetMigrationObjectStore(
			ctx,
			cfg.targetS3,
			cfg.targetBucket,
			cfg.tempDirectory,
		)
	}
	if err != nil {
		return err
	}
	service := attachmentmigration.New(repository, repository, objects)

	switch cfg.command {
	case "preview":
		result, err := service.Preview(ctx, cfg.runID, cfg.pageSize)
		if err != nil {
			return err
		}
		writeJSON(map[string]any{
			"status":  "ok",
			"command": "preview",
			"run_id":  result.RunID,
			"planned": result.Planned,
			"skipped": result.Skipped,
			"issues":  result.Issues,
			"writes":  false,
		})
	case "plan":
		if err := requireConfirmation("PACA_ATTACHMENT_MIGRATION_PLAN", cfg.runID); err != nil {
			return err
		}
		result, err := service.Plan(ctx, cfg.runID, cfg.pageSize)
		if err != nil {
			return err
		}
		writeJSON(map[string]any{
			"status":  "ok",
			"command": "plan",
			"run_id":  result.RunID,
			"planned": result.Planned,
			"skipped": result.Skipped,
			"issues":  result.Issues,
		})
	case "apply":
		if err := requireConfirmation("PACA_ATTACHMENT_MIGRATION_APPLY", cfg.runID); err != nil {
			return err
		}
		result, err := service.Apply(ctx, cfg.runID)
		if err != nil {
			return err
		}
		writeOperation("apply", result)
		if result.Failed > 0 {
			return errors.New("attachment migration command: one or more apply items failed")
		}
	case "verify":
		result, err := service.Verify(ctx, cfg.runID)
		if err != nil {
			return err
		}
		writeOperation("verify", result)
		if result.Failed > 0 {
			return errors.New("attachment migration command: verification failed")
		}
	case "rollback":
		if err := requireConfirmation("PACA_ATTACHMENT_MIGRATION_ROLLBACK", cfg.runID); err != nil {
			return err
		}
		result, err := service.Rollback(ctx, cfg.runID, time.Now().UTC())
		if err != nil {
			return err
		}
		writeOperation("rollback", result)
		if result.Failed > 0 {
			return errors.New("attachment migration command: one or more rollback items failed")
		}
	case "orphan-audit", "orphan-delete":
		deleteObjects := cfg.command == "orphan-delete"
		if deleteObjects {
			confirmation := "DELETE_ORPHANS_BEFORE:" + cfg.orphanBefore.UTC().Format(time.RFC3339)
			if strings.TrimSpace(os.Getenv("PACA_ATTACHMENT_ORPHAN_DELETE")) != confirmation {
				return errors.New("attachment migration command: PACA_ATTACHMENT_ORPHAN_DELETE confirmation does not match cutoff")
			}
		}
		result, err := service.AuditOrphans(ctx, cfg.orphanBefore, deleteObjects)
		if err != nil {
			return err
		}
		writeJSON(map[string]any{
			"status":          "ok",
			"command":         cfg.command,
			"cutoff":          cfg.orphanBefore.UTC().Format(time.RFC3339),
			"scanned":         result.Scanned,
			"eligible":        result.Eligible,
			"orphans":         result.Orphans,
			"orphan_bytes":    result.OrphanBytes,
			"deleted":         result.Deleted,
			"delete_failures": result.DeleteFailures,
		})
		if result.DeleteFailures > 0 {
			return errors.New("attachment migration command: one or more orphan deletions failed")
		}
	default:
		return fmt.Errorf("attachment migration command: unsupported command %q", cfg.command)
	}
	return nil
}

func loadConfig() (config, error) {
	command := strings.ToLower(strings.TrimSpace(environment("PACA_ATTACHMENT_MIGRATION_COMMAND", "preview")))
	if command != "preview" && command != "plan" && command != "apply" &&
		command != "verify" && command != "rollback" && command != "orphan-audit" &&
		command != "orphan-delete" {
		return config{}, errors.New("attachment migration command: unsupported command")
	}
	runIDText := strings.TrimSpace(os.Getenv("PACA_ATTACHMENT_MIGRATION_RUN_ID"))
	var runID uuid.UUID
	var err error
	if runIDText == "" && (command == "preview" || command == "orphan-audit" || command == "orphan-delete") {
		runID = uuid.New()
	} else {
		runID, err = uuid.Parse(runIDText)
		if err != nil {
			return config{}, errors.New("attachment migration command: PACA_ATTACHMENT_MIGRATION_RUN_ID must be a UUID")
		}
	}
	pageSize, err := strconv.Atoi(environment("PACA_ATTACHMENT_MIGRATION_PAGE_SIZE", "100"))
	if err != nil || pageSize < 1 || pageSize > 1000 {
		return config{}, errors.New("attachment migration command: page size must be between 1 and 1000")
	}

	cfg := config{
		command:       command,
		runID:         runID,
		pageSize:      pageSize,
		sourceDBURL:   strings.TrimSpace(os.Getenv("LEGACY_DATABASE_URL")),
		targetDBURL:   strings.TrimSpace(os.Getenv("DATABASE_URL")),
		targetBucket:  strings.TrimSpace(os.Getenv("R2_BUCKET")),
		tempDirectory: strings.TrimSpace(os.Getenv("PACA_ATTACHMENT_MIGRATION_TEMP_DIR")),
	}
	if cfg.targetDBURL == "" || cfg.targetBucket == "" {
		return config{}, errors.New("attachment migration command: DATABASE_URL and R2_BUCKET are required")
	}
	if commandNeedsSourceDatabase(command) && cfg.sourceDBURL == "" {
		return config{}, errors.New("attachment migration command: LEGACY_DATABASE_URL is required")
	}
	if command == "apply" {
		forcePathStyle, parseErr := environmentBool("LEGACY_S3_FORCE_PATH_STYLE", true)
		if parseErr != nil {
			return config{}, parseErr
		}
		cfg.sourceS3 = attachmentmigration.S3EndpointConfig{
			Endpoint:        strings.TrimSpace(os.Getenv("LEGACY_S3_ENDPOINT")),
			Region:          environment("LEGACY_S3_REGION", "us-east-1"),
			AccessKeyID:     strings.TrimSpace(os.Getenv("LEGACY_S3_ACCESS_KEY_ID")),
			SecretAccessKey: strings.TrimSpace(os.Getenv("LEGACY_S3_SECRET_ACCESS_KEY")),
			ForcePathStyle:  forcePathStyle,
		}
	}
	if command == "apply" || command == "verify" || command == "rollback" ||
		command == "orphan-audit" || command == "orphan-delete" {
		forcePathStyle, parseErr := environmentBool("R2_FORCE_PATH_STYLE", false)
		if parseErr != nil {
			return config{}, parseErr
		}
		cfg.targetS3 = attachmentmigration.S3EndpointConfig{
			Endpoint:        strings.TrimSpace(os.Getenv("R2_S3_ENDPOINT")),
			Region:          environment("R2_REGION", "auto"),
			AccessKeyID:     strings.TrimSpace(os.Getenv("R2_ACCESS_KEY_ID")),
			SecretAccessKey: strings.TrimSpace(os.Getenv("R2_SECRET_ACCESS_KEY")),
			ForcePathStyle:  forcePathStyle,
		}
		if cfg.targetS3.Endpoint == "" {
			return config{}, errors.New("attachment migration command: R2_S3_ENDPOINT is required")
		}
		if err := validateR2Endpoint(cfg.targetS3.Endpoint); err != nil {
			return config{}, err
		}
	}
	if command == "orphan-audit" || command == "orphan-delete" {
		before := strings.TrimSpace(os.Getenv("PACA_ATTACHMENT_ORPHAN_BEFORE"))
		if before == "" {
			if command == "orphan-delete" {
				return config{}, errors.New("attachment migration command: PACA_ATTACHMENT_ORPHAN_BEFORE is required for deletion")
			}
			cfg.orphanBefore = time.Now().UTC().Add(-30 * 24 * time.Hour)
		} else {
			cfg.orphanBefore, err = time.Parse(time.RFC3339, before)
			if err != nil {
				return config{}, errors.New("attachment migration command: PACA_ATTACHMENT_ORPHAN_BEFORE must be RFC3339")
			}
		}
	}
	return cfg, nil
}

func commandNeedsSourceDatabase(command string) bool {
	return command == "preview" || command == "plan" || command == "apply" || command == "verify"
}

func requireConfirmation(name string, runID uuid.UUID) error {
	if strings.TrimSpace(os.Getenv(name)) != runID.String() {
		return fmt.Errorf("attachment migration command: %s must exactly equal the run id", name)
	}
	return nil
}

func environment(name, fallback string) string {
	if value := strings.TrimSpace(os.Getenv(name)); value != "" {
		return value
	}
	return fallback
}

func environmentBool(name string, fallback bool) (bool, error) {
	value := strings.TrimSpace(os.Getenv(name))
	if value == "" {
		return fallback, nil
	}
	parsed, err := strconv.ParseBool(value)
	if err != nil {
		return false, fmt.Errorf("attachment migration command: %s must be true or false", name)
	}
	return parsed, nil
}

func validateR2Endpoint(value string) error {
	parsed, err := url.Parse(value)
	if err != nil || parsed.Scheme != "https" || parsed.User != nil || parsed.Hostname() == "" ||
		parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" ||
		!strings.HasSuffix(strings.ToLower(parsed.Hostname()), ".r2.cloudflarestorage.com") {
		return errors.New("attachment migration command: R2_S3_ENDPOINT must be an HTTPS Cloudflare R2 account endpoint")
	}
	return nil
}

func writeOperation(command string, result attachmentmigration.OperationResult) {
	writeJSON(map[string]any{
		"status":    "ok",
		"command":   command,
		"run_id":    result.RunID,
		"succeeded": result.Succeeded,
		"failed":    result.Failed,
	})
}

func writeJSON(value map[string]any) {
	encoded, err := json.Marshal(value)
	if err != nil {
		fmt.Fprintln(os.Stderr, `{"status":"error","error":"json encoding failed"}`)
		return
	}
	fmt.Println(string(encoded))
}
