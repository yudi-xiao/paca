package attachmentmigration

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jmoiron/sqlx"
)

type PostgresRepository struct {
	source       *sqlx.DB
	target       *sqlx.DB
	targetBucket string
}

func NewPostgresRepository(source, target *sqlx.DB, targetBucket string) *PostgresRepository {
	return &PostgresRepository{source: source, target: target, targetBucket: targetBucket}
}

type legacyAttachmentRow struct {
	SourceFileID       uuid.UUID  `db:"source_file_id"`
	SourceAttachmentID uuid.UUID  `db:"source_attachment_id"`
	ProjectID          uuid.UUID  `db:"project_id"`
	TaskID             uuid.UUID  `db:"task_id"`
	SourceBucket       string     `db:"source_bucket"`
	SourceKey          string     `db:"source_key"`
	FileName           string     `db:"file_name"`
	ContentType        string     `db:"content_type"`
	Size               int64      `db:"file_size"`
	UploadedBy         *uuid.UUID `db:"uploaded_by"`
	CreatedBy          *uuid.UUID `db:"created_by"`
	CreatedAt          time.Time  `db:"created_at"`
}

const legacyAttachmentSelect = `
SELECT
  f.id AS source_file_id,
  ta.id AS source_attachment_id,
  t.project_id,
  ta.task_id,
  f.bucket AS source_bucket,
  f.storage_key AS source_key,
  f.file_name,
  f.content_type,
  f.file_size,
  f.uploaded_by,
  ta.created_by,
  ta.created_at
FROM task_attachments ta
JOIN files f ON f.id = ta.file_id
JOIN tasks t ON t.id = ta.task_id`

func (r *PostgresRepository) ListUploaded(
	ctx context.Context,
	after uuid.UUID,
	limit int,
) ([]LegacyAttachment, error) {
	rows := make([]legacyAttachmentRow, 0, limit)
	err := r.source.SelectContext(
		ctx,
		&rows,
		legacyAttachmentSelect+`
WHERE f.upload_status = 'uploaded' AND ta.id > $1
ORDER BY ta.id
LIMIT $2`,
		after,
		limit,
	)
	if err != nil {
		return nil, fmt.Errorf("attachment migration postgres: list source: %w", err)
	}
	result := make([]LegacyAttachment, 0, len(rows))
	for _, row := range rows {
		result = append(result, legacyAttachmentFromRow(row))
	}
	return result, nil
}

func (r *PostgresRepository) Find(
	ctx context.Context,
	attachmentID uuid.UUID,
) (LegacyAttachment, error) {
	var row legacyAttachmentRow
	err := r.source.GetContext(
		ctx,
		&row,
		legacyAttachmentSelect+`
WHERE f.upload_status = 'uploaded' AND ta.id = $1`,
		attachmentID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return LegacyAttachment{}, errors.New("attachment migration postgres: source attachment not found")
	}
	if err != nil {
		return LegacyAttachment{}, fmt.Errorf("attachment migration postgres: find source: %w", err)
	}
	return legacyAttachmentFromRow(row), nil
}

func legacyAttachmentFromRow(row legacyAttachmentRow) LegacyAttachment {
	return LegacyAttachment{
		SourceFileID:       row.SourceFileID,
		SourceAttachmentID: row.SourceAttachmentID,
		ProjectID:          row.ProjectID,
		TaskID:             row.TaskID,
		SourceBucket:       row.SourceBucket,
		SourceKey:          row.SourceKey,
		FileName:           row.FileName,
		ContentType:        row.ContentType,
		Size:               row.Size,
		UploadedBy:         row.UploadedBy,
		CreatedBy:          row.CreatedBy,
		CreatedAt:          row.CreatedAt,
	}
}

func (r *PostgresRepository) ResolveScope(
	ctx context.Context,
	projectID, taskID uuid.UUID,
) (TargetScope, error) {
	var organizationID string
	err := r.target.GetContext(
		ctx,
		&organizationID,
		`SELECT p.organization_id
FROM paca_task t
JOIN paca_project p ON p.id = t.project_id
WHERE p.id = $1 AND t.id = $2`,
		projectID,
		taskID,
	)
	if errors.Is(err, sql.ErrNoRows) {
		return TargetScope{}, errors.New("attachment migration postgres: target task scope not found")
	}
	if err != nil {
		return TargetScope{}, fmt.Errorf("attachment migration postgres: resolve target scope: %w", err)
	}
	return TargetScope{
		OrganizationID: organizationID,
		ProjectID:      projectID,
		TaskID:         taskID,
		TargetBucket:   r.targetBucket,
	}, nil
}

func (r *PostgresRepository) Plan(ctx context.Context, item PlannedItem) (bool, error) {
	var id uuid.UUID
	err := r.target.GetContext(
		ctx,
		&id,
		`INSERT INTO paca_attachment_migration_item (
  run_id, source_bucket, source_key, source_file_id, source_attachment_id,
  target_file_id, target_attachment_id, target_bucket, target_storage_key, source_size, status
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'planned')
ON CONFLICT DO NOTHING
RETURNING id`,
		item.RunID,
		item.SourceBucket,
		item.SourceKey,
		item.SourceFileID,
		item.SourceAttachmentID,
		item.TargetFileID,
		item.TargetAttachmentID,
		item.TargetBucket,
		item.TargetStorageKey,
		item.SourceSize,
	)
	if errors.Is(err, sql.ErrNoRows) {
		var existing plannedItemRow
		err = r.target.GetContext(
			ctx,
			&existing,
			`SELECT run_id, source_bucket, source_key, source_file_id, source_attachment_id,
  target_file_id, target_attachment_id, target_bucket, target_storage_key, source_size, sha256,
  target_etag, status, owns_target_object, owns_target_file, owns_target_attachment,
  rollback_started_at
FROM paca_attachment_migration_item
WHERE run_id = $1 AND source_attachment_id = $2`,
			item.RunID,
			item.SourceAttachmentID,
		)
		if errors.Is(err, sql.ErrNoRows) {
			return false, errors.New("attachment migration postgres: source attachment belongs to another active run")
		}
		if err != nil {
			return false, fmt.Errorf("attachment migration postgres: read existing plan: %w", err)
		}
		if !samePlan(plannedItemFromRow(existing), item) {
			return false, errors.New("attachment migration postgres: existing plan differs from requested plan")
		}
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("attachment migration postgres: insert plan: %w", err)
	}
	return true, nil
}

func samePlan(existing, requested PlannedItem) bool {
	return existing.RunID == requested.RunID &&
		existing.SourceBucket == requested.SourceBucket &&
		existing.SourceKey == requested.SourceKey &&
		existing.SourceFileID == requested.SourceFileID &&
		existing.SourceAttachmentID == requested.SourceAttachmentID &&
		existing.TargetFileID == requested.TargetFileID &&
		existing.TargetAttachmentID == requested.TargetAttachmentID &&
		existing.TargetBucket == requested.TargetBucket &&
		existing.TargetStorageKey == requested.TargetStorageKey &&
		existing.SourceSize == requested.SourceSize
}

type plannedItemRow struct {
	RunID                uuid.UUID  `db:"run_id"`
	SourceBucket         string     `db:"source_bucket"`
	SourceKey            string     `db:"source_key"`
	SourceFileID         uuid.UUID  `db:"source_file_id"`
	SourceAttachmentID   uuid.UUID  `db:"source_attachment_id"`
	TargetFileID         uuid.UUID  `db:"target_file_id"`
	TargetAttachmentID   uuid.UUID  `db:"target_attachment_id"`
	TargetBucket         string     `db:"target_bucket"`
	TargetStorageKey     string     `db:"target_storage_key"`
	SourceSize           int64      `db:"source_size"`
	SHA256               *string    `db:"sha256"`
	TargetETag           *string    `db:"target_etag"`
	Status               string     `db:"status"`
	OwnsTargetObject     bool       `db:"owns_target_object"`
	OwnsTargetFile       bool       `db:"owns_target_file"`
	OwnsTargetAttachment bool       `db:"owns_target_attachment"`
	RollbackStartedAt    *time.Time `db:"rollback_started_at"`
}

func (r *PostgresRepository) ListRun(
	ctx context.Context,
	runID uuid.UUID,
	statuses []string,
) ([]PlannedItem, error) {
	if len(statuses) == 0 {
		return []PlannedItem{}, nil
	}
	query, args, err := sqlx.In(
		`SELECT run_id, source_bucket, source_key, source_file_id, source_attachment_id,
  target_file_id, target_attachment_id, target_bucket, target_storage_key, source_size, sha256,
  target_etag, status, owns_target_object, owns_target_file, owns_target_attachment,
  rollback_started_at
FROM paca_attachment_migration_item
WHERE run_id = ? AND status IN (?)
ORDER BY source_attachment_id`,
		runID,
		statuses,
	)
	if err != nil {
		return nil, fmt.Errorf("attachment migration postgres: build run query: %w", err)
	}
	rows := make([]plannedItemRow, 0)
	if err := r.target.SelectContext(ctx, &rows, r.target.Rebind(query), args...); err != nil {
		return nil, fmt.Errorf("attachment migration postgres: list run: %w", err)
	}
	result := make([]PlannedItem, 0, len(rows))
	for _, row := range rows {
		result = append(result, plannedItemFromRow(row))
	}
	return result, nil
}

func plannedItemFromRow(row plannedItemRow) PlannedItem {
	return PlannedItem{
		RunID:                row.RunID,
		SourceBucket:         row.SourceBucket,
		SourceKey:            row.SourceKey,
		SourceFileID:         row.SourceFileID,
		SourceAttachmentID:   row.SourceAttachmentID,
		TargetFileID:         row.TargetFileID,
		TargetAttachmentID:   row.TargetAttachmentID,
		TargetBucket:         row.TargetBucket,
		TargetStorageKey:     row.TargetStorageKey,
		SourceSize:           row.SourceSize,
		Status:               row.Status,
		SHA256:               stringValue(row.SHA256),
		TargetETag:           stringValue(row.TargetETag),
		OwnsTargetObject:     row.OwnsTargetObject,
		OwnsTargetFile:       row.OwnsTargetFile,
		OwnsTargetAttachment: row.OwnsTargetAttachment,
		RollbackStartedAt:    row.RollbackStartedAt,
	}
}

func stringValue(value *string) string {
	if value == nil {
		return ""
	}
	return *value
}

func (r *PostgresRepository) MarkCopied(
	ctx context.Context,
	item PlannedItem,
	copied CopiedObject,
) error {
	if item.TargetBucket != r.targetBucket {
		return errors.New("attachment migration postgres: target bucket differs from migration plan")
	}
	result, err := r.target.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'copied', sha256 = $3, target_etag = $4,
    owns_target_object = owns_target_object OR $5,
    attempts = attempts + 1, error_code = NULL, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2
  AND status IN ('planned','copied','failed')`,
		item.RunID,
		item.SourceAttachmentID,
		copied.SHA256,
		copied.ETag,
		copied.Created,
	)
	return requireOneRow(result, err, "mark copied")
}

func (r *PostgresRepository) Import(
	ctx context.Context,
	item PlannedItem,
	source LegacyAttachment,
	copied CopiedObject,
) error {
	tx, err := r.target.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("attachment migration postgres: begin import: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	var organizationID string
	if err := tx.GetContext(
		ctx,
		&organizationID,
		`SELECT p.organization_id
FROM paca_task t JOIN paca_project p ON p.id = t.project_id
WHERE p.id = $1 AND t.id = $2`,
		source.ProjectID,
		source.TaskID,
	); err != nil {
		return fmt.Errorf("attachment migration postgres: verify import scope: %w", err)
	}
	uploadedBy, err := existingTargetUser(ctx, tx, source.UploadedBy)
	if err != nil {
		return err
	}
	createdBy, err := existingTargetUser(ctx, tx, source.CreatedBy)
	if err != nil {
		return err
	}
	contentType := strings.TrimSpace(source.ContentType)
	if contentType == "" {
		contentType = "application/octet-stream"
	}

	insertedFile, err := insertReturning(
		ctx,
		tx,
		`INSERT INTO paca_file (
  id, organization_id, project_id, task_id, storage_key, bucket, file_name,
  content_type, declared_size, actual_size, sha256, etag, upload_status,
  multipart_upload_id, uploaded_by, created_at, updated_at, completed_at
) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10,$11,'uploaded',NULL,$12,$13,$13,$13)
ON CONFLICT (id) DO NOTHING RETURNING id`,
		item.TargetFileID,
		organizationID,
		source.ProjectID,
		source.TaskID,
		item.TargetStorageKey,
		r.targetBucket,
		source.FileName,
		contentType,
		copied.Size,
		copied.SHA256,
		copied.ETag,
		uploadedBy,
		source.CreatedAt,
	)
	if err != nil {
		return err
	}
	if err := verifyTargetFile(ctx, tx, item, source, copied, organizationID, r.targetBucket); err != nil {
		return err
	}

	insertedAttachment, err := insertReturning(
		ctx,
		tx,
		`INSERT INTO paca_task_attachment (
  id, project_id, task_id, file_id, created_by, created_at,
  deleted_at, purge_after, purge_started_at
) VALUES ($1,$2,$3,$4,$5,$6,NULL,NULL,NULL)
ON CONFLICT (id) DO NOTHING RETURNING id`,
		item.TargetAttachmentID,
		source.ProjectID,
		source.TaskID,
		item.TargetFileID,
		createdBy,
		source.CreatedAt,
	)
	if err != nil {
		return err
	}
	if err := verifyTargetAttachment(ctx, tx, item, source); err != nil {
		return err
	}

	result, err := tx.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'imported', sha256 = $3, target_etag = $4,
    owns_target_object = owns_target_object OR $5,
    owns_target_file = owns_target_file OR $6,
    owns_target_attachment = owns_target_attachment OR $7,
    error_code = NULL, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2
  AND status IN ('copied','imported')`,
		item.RunID,
		item.SourceAttachmentID,
		copied.SHA256,
		copied.ETag,
		copied.Created,
		insertedFile,
		insertedAttachment,
	)
	if err := requireOneRow(result, err, "mark imported"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("attachment migration postgres: commit import: %w", err)
	}
	return nil
}

func existingTargetUser(
	ctx context.Context,
	tx *sqlx.Tx,
	legacyID *uuid.UUID,
) (*string, error) {
	if legacyID == nil {
		return nil, nil
	}
	id := legacyID.String()
	var existing string
	err := tx.GetContext(ctx, &existing, `SELECT id FROM "user" WHERE id = $1`, id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("attachment migration postgres: resolve target user: %w", err)
	}
	return &existing, nil
}

func insertReturning(ctx context.Context, tx *sqlx.Tx, query string, args ...any) (bool, error) {
	var id uuid.UUID
	err := tx.GetContext(ctx, &id, query, args...)
	if errors.Is(err, sql.ErrNoRows) {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("attachment migration postgres: insert target metadata: %w", err)
	}
	return true, nil
}

func verifyTargetFile(
	ctx context.Context,
	tx *sqlx.Tx,
	item PlannedItem,
	source LegacyAttachment,
	copied CopiedObject,
	organizationID, targetBucket string,
) error {
	var count int
	err := tx.GetContext(
		ctx,
		&count,
		`SELECT COUNT(*) FROM paca_file
WHERE id = $1 AND organization_id = $2 AND project_id = $3 AND task_id = $4
  AND storage_key = $5 AND bucket = $6 AND declared_size = $7 AND actual_size = $7
  AND sha256 = $8 AND etag = $9 AND upload_status = 'uploaded'`,
		item.TargetFileID,
		organizationID,
		source.ProjectID,
		source.TaskID,
		item.TargetStorageKey,
		targetBucket,
		copied.Size,
		copied.SHA256,
		copied.ETag,
	)
	if err != nil {
		return fmt.Errorf("attachment migration postgres: verify target file: %w", err)
	}
	if count != 1 {
		return errors.New("attachment migration postgres: conflicting target file metadata")
	}
	return nil
}

func verifyTargetAttachment(
	ctx context.Context,
	tx *sqlx.Tx,
	item PlannedItem,
	source LegacyAttachment,
) error {
	var count int
	err := tx.GetContext(
		ctx,
		&count,
		`SELECT COUNT(*) FROM paca_task_attachment
WHERE id = $1 AND project_id = $2 AND task_id = $3 AND file_id = $4`,
		item.TargetAttachmentID,
		source.ProjectID,
		source.TaskID,
		item.TargetFileID,
	)
	if err != nil {
		return fmt.Errorf("attachment migration postgres: verify target attachment: %w", err)
	}
	if count != 1 {
		return errors.New("attachment migration postgres: conflicting target attachment metadata")
	}
	return nil
}

func (r *PostgresRepository) MarkFailed(
	ctx context.Context,
	item PlannedItem,
	code string,
) error {
	result, err := r.target.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'failed', attempts = attempts + 1, error_code = $3, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2
  AND status IN ('planned','copied','failed')`,
		item.RunID,
		item.SourceAttachmentID,
		code,
	)
	return requireOneRow(result, err, "mark failed")
}

func (r *PostgresRepository) MarkRollbackFailed(
	ctx context.Context,
	item PlannedItem,
	code string,
) error {
	result, err := r.target.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'rollback_started', error_code = $3, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2 AND status = 'rollback_started'`,
		item.RunID,
		item.SourceAttachmentID,
		code,
	)
	return requireOneRow(result, err, "record rollback failure")
}

func (r *PostgresRepository) BeginRollback(
	ctx context.Context,
	item PlannedItem,
	now time.Time,
) (bool, error) {
	result, err := r.target.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'rollback_started', rollback_started_at = COALESCE(rollback_started_at, $3),
    error_code = NULL, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2
  AND status IN ('planned','copied','imported','failed','rollback_started')`,
		item.RunID,
		item.SourceAttachmentID,
		now,
	)
	if err != nil {
		return false, fmt.Errorf("attachment migration postgres: begin rollback: %w", err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return false, fmt.Errorf("attachment migration postgres: inspect rollback claim: %w", err)
	}
	return rows == 1, nil
}

func (r *PostgresRepository) FinishRollback(ctx context.Context, item PlannedItem) error {
	tx, err := r.target.BeginTxx(ctx, nil)
	if err != nil {
		return fmt.Errorf("attachment migration postgres: begin rollback metadata: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if item.OwnsTargetAttachment {
		if _, err := tx.ExecContext(
			ctx,
			`DELETE FROM paca_task_attachment
WHERE id = $1 AND file_id = $2`,
			item.TargetAttachmentID,
			item.TargetFileID,
		); err != nil {
			return fmt.Errorf("attachment migration postgres: delete target attachment: %w", err)
		}
	}
	if item.OwnsTargetFile {
		if _, err := tx.ExecContext(
			ctx,
			`DELETE FROM paca_file WHERE id = $1 AND storage_key = $2`,
			item.TargetFileID,
			item.TargetStorageKey,
		); err != nil {
			return fmt.Errorf("attachment migration postgres: delete target file: %w", err)
		}
	}
	result, err := tx.ExecContext(
		ctx,
		`UPDATE paca_attachment_migration_item
SET status = 'rolled_back', error_code = NULL, updated_at = NOW()
WHERE run_id = $1 AND source_attachment_id = $2 AND status = 'rollback_started'`,
		item.RunID,
		item.SourceAttachmentID,
	)
	if err := requireOneRow(result, err, "finish rollback"); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("attachment migration postgres: commit rollback metadata: %w", err)
	}
	return nil
}

func (r *PostgresRepository) VerifyMetadata(
	ctx context.Context,
	item PlannedItem,
	source LegacyAttachment,
	copied CopiedObject,
) error {
	tx, err := r.target.BeginTxx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return fmt.Errorf("attachment migration postgres: begin verify: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	var organizationID string
	if err := tx.GetContext(
		ctx,
		&organizationID,
		`SELECT p.organization_id
FROM paca_task t JOIN paca_project p ON p.id = t.project_id
WHERE p.id = $1 AND t.id = $2`,
		source.ProjectID,
		source.TaskID,
	); err != nil {
		return fmt.Errorf("attachment migration postgres: verify target scope: %w", err)
	}
	if err := verifyTargetFile(
		ctx,
		tx,
		item,
		source,
		copied,
		organizationID,
		r.targetBucket,
	); err != nil {
		return err
	}
	return verifyTargetAttachment(ctx, tx, item, source)
}

func (r *PostgresRepository) KnownStorageKeys(
	ctx context.Context,
	keys []string,
) (map[string]bool, error) {
	result := make(map[string]bool, len(keys))
	if len(keys) == 0 {
		return result, nil
	}
	query, args, err := sqlx.In(
		`SELECT storage_key FROM paca_file WHERE bucket = ? AND storage_key IN (?)`,
		r.targetBucket,
		keys,
	)
	if err != nil {
		return nil, fmt.Errorf("attachment migration postgres: build known key query: %w", err)
	}
	known := make([]string, 0, len(keys))
	if err := r.target.SelectContext(ctx, &known, r.target.Rebind(query), args...); err != nil {
		return nil, fmt.Errorf("attachment migration postgres: query known keys: %w", err)
	}
	for _, key := range known {
		result[key] = true
	}
	return result, nil
}

func requireOneRow(result sql.Result, err error, operation string) error {
	if err != nil {
		return fmt.Errorf("attachment migration postgres: %s: %w", operation, err)
	}
	rows, err := result.RowsAffected()
	if err != nil {
		return fmt.Errorf("attachment migration postgres: inspect %s: %w", operation, err)
	}
	if rows != 1 {
		return fmt.Errorf("attachment migration postgres: %s affected %d rows", operation, rows)
	}
	return nil
}
