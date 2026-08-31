// Package attachmentmigration implements a resumable, auditable migration from
// the legacy S3/MinIO attachment tables to Paca's Worker PostgreSQL and R2 model.
package attachmentmigration

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

const (
	MaxAttachmentSize = 512 * 1024 * 1024
	DefaultPageSize   = 100
)

type LegacyAttachment struct {
	SourceFileID       uuid.UUID
	SourceAttachmentID uuid.UUID
	ProjectID          uuid.UUID
	TaskID             uuid.UUID
	SourceBucket       string
	SourceKey          string
	FileName           string
	ContentType        string
	Size               int64
	UploadedBy         *uuid.UUID
	CreatedBy          *uuid.UUID
	CreatedAt          time.Time
}

type PlannedItem struct {
	RunID                uuid.UUID
	SourceBucket         string
	SourceKey            string
	SourceFileID         uuid.UUID
	SourceAttachmentID   uuid.UUID
	TargetFileID         uuid.UUID
	TargetAttachmentID   uuid.UUID
	TargetBucket         string
	TargetStorageKey     string
	SourceSize           int64
	Status               string
	SHA256               string
	TargetETag           string
	OwnsTargetObject     bool
	OwnsTargetFile       bool
	OwnsTargetAttachment bool
	RollbackStartedAt    *time.Time
}

type TargetScope struct {
	OrganizationID string
	ProjectID      uuid.UUID
	TaskID         uuid.UUID
	TargetBucket   string
}

type CopiedObject struct {
	Size    int64
	SHA256  string
	ETag    string
	Created bool
}

type PlanResult struct {
	RunID   uuid.UUID
	Planned int
	Skipped int
	Issues  []PlanIssue
}

type PlanIssue struct {
	SourceAttachmentID uuid.UUID `json:"source_attachment_id"`
	Code               string    `json:"code"`
}

type OperationResult struct {
	RunID     uuid.UUID
	Succeeded int
	Failed    int
}

type StoredObject struct {
	Key          string
	Size         int64
	LastModified time.Time
}

type ObjectPage struct {
	Items      []StoredObject
	NextCursor string
}

type OrphanAuditResult struct {
	Scanned        int
	Eligible       int
	Orphans        int
	OrphanBytes    int64
	Deleted        int
	DeleteFailures int
}

type SourceRepository interface {
	ListUploaded(ctx context.Context, after uuid.UUID, limit int) ([]LegacyAttachment, error)
	Find(ctx context.Context, attachmentID uuid.UUID) (LegacyAttachment, error)
}

type TargetRepository interface {
	ResolveScope(ctx context.Context, projectID, taskID uuid.UUID) (TargetScope, error)
	Plan(ctx context.Context, item PlannedItem) (bool, error)
	ListRun(ctx context.Context, runID uuid.UUID, statuses []string) ([]PlannedItem, error)
	MarkCopied(ctx context.Context, item PlannedItem, copied CopiedObject) error
	Import(ctx context.Context, item PlannedItem, source LegacyAttachment, copied CopiedObject) error
	MarkFailed(ctx context.Context, item PlannedItem, code string) error
	MarkRollbackFailed(ctx context.Context, item PlannedItem, code string) error
	BeginRollback(ctx context.Context, item PlannedItem, now time.Time) (bool, error)
	FinishRollback(ctx context.Context, item PlannedItem) error
	VerifyMetadata(ctx context.Context, item PlannedItem, source LegacyAttachment, copied CopiedObject) error
	KnownStorageKeys(ctx context.Context, keys []string) (map[string]bool, error)
}

type ObjectStore interface {
	TargetBucket() string
	Copy(ctx context.Context, runID uuid.UUID, source LegacyAttachment, targetKey string) (CopiedObject, error)
	Verify(ctx context.Context, targetKey string, maxBytes int64) (CopiedObject, error)
	Delete(ctx context.Context, targetKey string) error
	List(ctx context.Context, prefix, cursor string, limit int) (ObjectPage, error)
}

type Service struct {
	source  SourceRepository
	target  TargetRepository
	objects ObjectStore
}

func New(source SourceRepository, target TargetRepository, objects ObjectStore) *Service {
	return &Service{source: source, target: target, objects: objects}
}

func (s *Service) Preview(ctx context.Context, runID uuid.UUID, pageSize int) (PlanResult, error) {
	return s.plan(ctx, runID, pageSize, false)
}

func (s *Service) Plan(ctx context.Context, runID uuid.UUID, pageSize int) (PlanResult, error) {
	return s.plan(ctx, runID, pageSize, true)
}

func (s *Service) plan(
	ctx context.Context,
	runID uuid.UUID,
	pageSize int,
	persist bool,
) (PlanResult, error) {
	if runID == uuid.Nil {
		return PlanResult{}, errors.New("attachment migration: run id is required")
	}
	if pageSize < 1 || pageSize > 1000 {
		return PlanResult{}, errors.New("attachment migration: page size must be between 1 and 1000")
	}

	result := PlanResult{RunID: runID}
	after := uuid.Nil
	for {
		rows, err := s.source.ListUploaded(ctx, after, pageSize)
		if err != nil {
			return result, fmt.Errorf("attachment migration: list legacy attachments: %w", err)
		}
		for _, source := range rows {
			if source.SourceAttachmentID == uuid.Nil ||
				(after != uuid.Nil && source.SourceAttachmentID.String() <= after.String()) {
				return result, errors.New("attachment migration: source pagination did not advance")
			}
			after = source.SourceAttachmentID
			if err := validateSource(source); err != nil {
				result.Skipped++
				result.addIssue(source.SourceAttachmentID, "SOURCE_METADATA_INVALID")
				continue
			}
			scope, err := s.target.ResolveScope(ctx, source.ProjectID, source.TaskID)
			if err != nil {
				result.Skipped++
				result.addIssue(source.SourceAttachmentID, "TARGET_SCOPE_MISSING")
				continue
			}
			item := PlannedItem{
				RunID:              runID,
				SourceBucket:       source.SourceBucket,
				SourceKey:          source.SourceKey,
				SourceFileID:       source.SourceFileID,
				SourceAttachmentID: source.SourceAttachmentID,
				// A legacy file may be linked to more than one task. Using the
				// attachment id as the target file id keeps every target aggregate
				// independently scoped and makes retries deterministic.
				TargetFileID:       source.SourceAttachmentID,
				TargetAttachmentID: source.SourceAttachmentID,
				TargetBucket:       scope.TargetBucket,
				TargetStorageKey: canonicalStorageKey(
					scope.OrganizationID,
					scope.ProjectID,
					scope.TaskID,
					source.SourceAttachmentID,
					source.FileName,
				),
				SourceSize: source.Size,
				Status:     "planned",
			}
			created := true
			if persist {
				created, err = s.target.Plan(ctx, item)
				if err != nil {
					return result, fmt.Errorf("attachment migration: persist plan: %w", err)
				}
			}
			if created {
				result.Planned++
			}
		}
		if len(rows) < pageSize {
			return result, nil
		}
	}
}

func (r *PlanResult) addIssue(attachmentID uuid.UUID, code string) {
	if len(r.Issues) >= 100 {
		return
	}
	r.Issues = append(r.Issues, PlanIssue{SourceAttachmentID: attachmentID, Code: code})
}

func (s *Service) Apply(ctx context.Context, runID uuid.UUID) (OperationResult, error) {
	items, err := s.target.ListRun(ctx, runID, []string{"planned", "copied", "failed"})
	if err != nil {
		return OperationResult{RunID: runID}, fmt.Errorf("attachment migration: list apply work: %w", err)
	}
	result := OperationResult{RunID: runID}
	for _, item := range items {
		if item.TargetBucket != s.objects.TargetBucket() {
			s.fail(ctx, item, "TARGET_BUCKET_MISMATCH")
			result.Failed++
			continue
		}
		source, err := s.source.Find(ctx, item.SourceAttachmentID)
		if err != nil {
			s.fail(ctx, item, "SOURCE_METADATA_MISSING")
			result.Failed++
			continue
		}
		if err := s.verifyPlannedSource(ctx, item, source); err != nil {
			s.fail(ctx, item, "SOURCE_PLAN_DRIFT")
			result.Failed++
			continue
		}
		var copied CopiedObject
		if item.Status == "copied" && item.SHA256 != "" && item.TargetETag != "" {
			copied, err = s.objects.Verify(ctx, item.TargetStorageKey, item.SourceSize)
			if err == nil && (copied.SHA256 != item.SHA256 || copied.Size != item.SourceSize) {
				err = errors.New("copied object no longer matches migration ledger")
			}
		} else {
			copied, err = s.objects.Copy(ctx, runID, source, item.TargetStorageKey)
			if err == nil {
				err = s.target.MarkCopied(ctx, item, copied)
			}
		}
		if err != nil {
			s.fail(ctx, item, "OBJECT_COPY_FAILED")
			result.Failed++
			continue
		}
		if err := s.target.Import(ctx, item, source, copied); err != nil {
			s.fail(ctx, item, "TARGET_IMPORT_FAILED")
			result.Failed++
			continue
		}
		result.Succeeded++
	}
	return result, nil
}

func (s *Service) Verify(ctx context.Context, runID uuid.UUID) (OperationResult, error) {
	items, err := s.target.ListRun(
		ctx,
		runID,
		[]string{"planned", "copied", "imported", "failed", "rollback_started", "rolled_back"},
	)
	if err != nil {
		return OperationResult{RunID: runID}, fmt.Errorf("attachment migration: list verify work: %w", err)
	}
	if len(items) == 0 {
		return OperationResult{RunID: runID}, errors.New("attachment migration: run has no planned items")
	}
	result := OperationResult{RunID: runID}
	for _, item := range items {
		if item.Status != "imported" || item.TargetBucket != s.objects.TargetBucket() {
			result.Failed++
			continue
		}
		source, sourceErr := s.source.Find(ctx, item.SourceAttachmentID)
		if sourceErr == nil {
			sourceErr = s.verifyPlannedSource(ctx, item, source)
		}
		copied, objectErr := s.objects.Verify(ctx, item.TargetStorageKey, item.SourceSize)
		if sourceErr != nil || objectErr != nil || copied.SHA256 != item.SHA256 {
			result.Failed++
			continue
		}
		if err := s.target.VerifyMetadata(ctx, item, source, copied); err != nil {
			result.Failed++
			continue
		}
		result.Succeeded++
	}
	return result, nil
}

func (s *Service) Rollback(ctx context.Context, runID uuid.UUID, now time.Time) (OperationResult, error) {
	items, err := s.target.ListRun(
		ctx,
		runID,
		[]string{"planned", "copied", "imported", "failed", "rollback_started"},
	)
	if err != nil {
		return OperationResult{RunID: runID}, fmt.Errorf("attachment migration: list rollback work: %w", err)
	}
	result := OperationResult{RunID: runID}
	for _, item := range items {
		if item.TargetBucket != s.objects.TargetBucket() {
			result.Failed++
			continue
		}
		claimed, err := s.target.BeginRollback(ctx, item, now)
		if err != nil || !claimed {
			result.Failed++
			continue
		}
		if item.OwnsTargetObject {
			if err := s.objects.Delete(ctx, item.TargetStorageKey); err != nil {
				_ = s.target.MarkRollbackFailed(ctx, item, "ROLLBACK_OBJECT_DELETE_FAILED")
				result.Failed++
				continue
			}
		}
		if err := s.target.FinishRollback(ctx, item); err != nil {
			_ = s.target.MarkRollbackFailed(ctx, item, "ROLLBACK_METADATA_DELETE_FAILED")
			result.Failed++
			continue
		}
		result.Succeeded++
	}
	return result, nil
}

func (s *Service) AuditOrphans(
	ctx context.Context,
	cutoff time.Time,
	deleteObjects bool,
) (OrphanAuditResult, error) {
	result := OrphanAuditResult{}
	cursor := ""
	for {
		page, err := s.objects.List(ctx, "organizations/", cursor, 1000)
		if err != nil {
			return result, fmt.Errorf("attachment migration: list target objects: %w", err)
		}
		result.Scanned += len(page.Items)
		eligible := make([]StoredObject, 0, len(page.Items))
		keys := make([]string, 0, len(page.Items))
		for _, object := range page.Items {
			if !isCanonicalTaskAttachmentKey(object.Key) || !object.LastModified.Before(cutoff) {
				continue
			}
			eligible = append(eligible, object)
			keys = append(keys, object.Key)
		}
		result.Eligible += len(eligible)
		known, err := s.target.KnownStorageKeys(ctx, keys)
		if err != nil {
			return result, fmt.Errorf("attachment migration: query known target keys: %w", err)
		}
		for _, object := range eligible {
			if known[object.Key] {
				continue
			}
			result.Orphans++
			result.OrphanBytes += object.Size
			if !deleteObjects {
				continue
			}
			// Recheck immediately before deletion. New uploads create their
			// database row before writing R2, so this protects the only normal
			// race without treating a bucket listing as authoritative state.
			current, err := s.target.KnownStorageKeys(ctx, []string{object.Key})
			if err != nil {
				result.DeleteFailures++
				continue
			}
			if current[object.Key] {
				result.Orphans--
				result.OrphanBytes -= object.Size
				continue
			}
			if err := s.objects.Delete(ctx, object.Key); err != nil {
				result.DeleteFailures++
				continue
			}
			result.Deleted++
		}
		if page.NextCursor == "" {
			return result, nil
		}
		if page.NextCursor == cursor {
			return result, errors.New("attachment migration: object listing cursor did not advance")
		}
		cursor = page.NextCursor
	}
}

func (s *Service) fail(ctx context.Context, item PlannedItem, code string) {
	_ = s.target.MarkFailed(ctx, item, code)
}

func (s *Service) verifyPlannedSource(
	ctx context.Context,
	item PlannedItem,
	source LegacyAttachment,
) error {
	if source.SourceFileID != item.SourceFileID ||
		source.SourceAttachmentID != item.SourceAttachmentID ||
		source.SourceBucket != item.SourceBucket ||
		source.SourceKey != item.SourceKey ||
		source.Size != item.SourceSize {
		return errors.New("attachment migration: source metadata differs from plan")
	}
	scope, err := s.target.ResolveScope(ctx, source.ProjectID, source.TaskID)
	if err != nil {
		return errors.New("attachment migration: target scope differs from plan")
	}
	wantKey := canonicalStorageKey(
		scope.OrganizationID,
		scope.ProjectID,
		scope.TaskID,
		source.SourceAttachmentID,
		source.FileName,
	)
	if scope.TargetBucket != item.TargetBucket || wantKey != item.TargetStorageKey {
		return errors.New("attachment migration: target scope differs from plan")
	}
	return nil
}

func validateSource(source LegacyAttachment) error {
	if source.SourceFileID == uuid.Nil || source.SourceAttachmentID == uuid.Nil ||
		source.ProjectID == uuid.Nil || source.TaskID == uuid.Nil {
		return errors.New("attachment migration: invalid source ids")
	}
	if strings.TrimSpace(source.SourceBucket) == "" || strings.TrimSpace(source.SourceKey) == "" {
		return errors.New("attachment migration: source object location is empty")
	}
	if source.Size < 1 || source.Size > MaxAttachmentSize {
		return errors.New("attachment migration: source size is outside supported range")
	}
	if strings.TrimSpace(source.FileName) == "" || !utf8.ValidString(source.FileName) {
		return errors.New("attachment migration: source file name is invalid")
	}
	return nil
}

func canonicalStorageKey(
	organizationID string,
	projectID, taskID, fileID uuid.UUID,
	fileName string,
) string {
	compactName := strings.Join(strings.Fields(fileName), "_")
	encodedName := encodedSegment(compactName)
	if len(encodedName) > 360 {
		encodedName = encodedName[:360]
	}
	if encodedName == "" {
		encodedName = "file"
	}
	return strings.Join([]string{
		"organizations",
		encodedSegment(organizationID),
		"projects",
		encodedSegment(projectID.String()),
		"tasks",
		encodedSegment(taskID.String()),
		"attachments",
		fileID.String(),
		encodedName,
	}, "/")
}

func encodedSegment(value string) string {
	return strings.ReplaceAll(url.PathEscape(value), "%", "~")
}

func isCanonicalTaskAttachmentKey(key string) bool {
	parts := strings.Split(key, "/")
	if len(parts) != 9 || parts[0] != "organizations" || parts[1] == "" ||
		parts[2] != "projects" || parts[4] != "tasks" || parts[6] != "attachments" ||
		parts[8] == "" {
		return false
	}
	for _, index := range []int{3, 5, 7} {
		if _, err := uuid.Parse(parts[index]); err != nil {
			return false
		}
	}
	return true
}
