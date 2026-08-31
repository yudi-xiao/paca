package attachmentmigration

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
)

var (
	runID        = uuid.MustParse("db217b8c-0542-4b96-bc26-febd9d10a388")
	projectID    = uuid.MustParse("6bdb7f3a-e59d-4826-8383-0104192157a8")
	taskID       = uuid.MustParse("c9d8cdf1-b208-4c87-b71f-cf4cdf2d373a")
	fileID       = uuid.MustParse("7b2646f8-da57-4f5a-8f54-1407ca012c84")
	attachmentID = uuid.MustParse("e0db602e-41c8-4cc1-b504-8d972ecb7e44")
)

type fakeSource struct {
	items []LegacyAttachment
}

type stuckSource struct {
	item LegacyAttachment
}

func (s *stuckSource) ListUploaded(
	_ context.Context,
	_ uuid.UUID,
	_ int,
) ([]LegacyAttachment, error) {
	return []LegacyAttachment{s.item}, nil
}

func (s *stuckSource) Find(_ context.Context, _ uuid.UUID) (LegacyAttachment, error) {
	return s.item, nil
}

func (f *fakeSource) ListUploaded(_ context.Context, after uuid.UUID, limit int) ([]LegacyAttachment, error) {
	result := make([]LegacyAttachment, 0, limit)
	for _, item := range f.items {
		if after != uuid.Nil && item.SourceAttachmentID.String() <= after.String() {
			continue
		}
		result = append(result, item)
		if len(result) == limit {
			break
		}
	}
	return result, nil
}

func (f *fakeSource) Find(_ context.Context, id uuid.UUID) (LegacyAttachment, error) {
	for _, item := range f.items {
		if item.SourceAttachmentID == id {
			return item, nil
		}
	}
	return LegacyAttachment{}, errors.New("not found")
}

type fakeTarget struct {
	items                []PlannedItem
	copied               []uuid.UUID
	imported             []uuid.UUID
	failed               map[uuid.UUID]string
	rollbackFailed       map[uuid.UUID]string
	rolledBack           []uuid.UUID
	verifyMetadataCalled int
	knownKeys            map[string]bool
}

func (f *fakeTarget) ResolveScope(_ context.Context, project, task uuid.UUID) (TargetScope, error) {
	if project != projectID || task == uuid.Nil {
		return TargetScope{}, errors.New("scope missing")
	}
	return TargetScope{
		OrganizationID: "paca/default",
		ProjectID:      project,
		TaskID:         task,
		TargetBucket:   "target-bucket",
	}, nil
}

func (f *fakeTarget) Plan(_ context.Context, item PlannedItem) (bool, error) {
	for _, current := range f.items {
		if current.RunID == item.RunID && current.SourceAttachmentID == item.SourceAttachmentID {
			return false, nil
		}
	}
	f.items = append(f.items, item)
	return true, nil
}

func (f *fakeTarget) ListRun(_ context.Context, id uuid.UUID, statuses []string) ([]PlannedItem, error) {
	allowed := make(map[string]bool, len(statuses))
	for _, status := range statuses {
		allowed[status] = true
	}
	result := make([]PlannedItem, 0)
	for _, item := range f.items {
		if item.RunID == id && allowed[item.Status] {
			result = append(result, item)
		}
	}
	return result, nil
}

func (f *fakeTarget) MarkCopied(_ context.Context, item PlannedItem, copied CopiedObject) error {
	f.copied = append(f.copied, item.SourceAttachmentID)
	f.update(item.SourceAttachmentID, func(current *PlannedItem) {
		current.Status = "copied"
		current.SHA256 = copied.SHA256
		current.TargetETag = copied.ETag
		current.OwnsTargetObject = current.OwnsTargetObject || copied.Created
	})
	return nil
}

func (f *fakeTarget) Import(_ context.Context, item PlannedItem, _ LegacyAttachment, _ CopiedObject) error {
	f.imported = append(f.imported, item.SourceAttachmentID)
	f.update(item.SourceAttachmentID, func(current *PlannedItem) { current.Status = "imported" })
	return nil
}

func (f *fakeTarget) MarkFailed(_ context.Context, item PlannedItem, code string) error {
	if f.failed == nil {
		f.failed = make(map[uuid.UUID]string)
	}
	f.failed[item.SourceAttachmentID] = code
	f.update(item.SourceAttachmentID, func(current *PlannedItem) { current.Status = "failed" })
	return nil
}

func (f *fakeTarget) MarkRollbackFailed(_ context.Context, item PlannedItem, code string) error {
	if f.rollbackFailed == nil {
		f.rollbackFailed = make(map[uuid.UUID]string)
	}
	f.rollbackFailed[item.SourceAttachmentID] = code
	f.update(item.SourceAttachmentID, func(current *PlannedItem) { current.Status = "rollback_started" })
	return nil
}

func (f *fakeTarget) BeginRollback(_ context.Context, item PlannedItem, now time.Time) (bool, error) {
	f.update(item.SourceAttachmentID, func(current *PlannedItem) {
		current.Status = "rollback_started"
		current.RollbackStartedAt = &now
	})
	return true, nil
}

func (f *fakeTarget) FinishRollback(_ context.Context, item PlannedItem) error {
	f.rolledBack = append(f.rolledBack, item.SourceAttachmentID)
	f.update(item.SourceAttachmentID, func(current *PlannedItem) { current.Status = "rolled_back" })
	return nil
}

func (f *fakeTarget) VerifyMetadata(
	_ context.Context,
	_ PlannedItem,
	_ LegacyAttachment,
	_ CopiedObject,
) error {
	f.verifyMetadataCalled++
	return nil
}

func (f *fakeTarget) KnownStorageKeys(
	_ context.Context,
	keys []string,
) (map[string]bool, error) {
	result := make(map[string]bool, len(keys))
	for _, key := range keys {
		result[key] = f.knownKeys[key]
	}
	return result, nil
}

func (f *fakeTarget) update(id uuid.UUID, operation func(*PlannedItem)) {
	for index := range f.items {
		if f.items[index].SourceAttachmentID == id {
			operation(&f.items[index])
		}
	}
}

type fakeObjects struct {
	copyError    error
	deleteError  error
	copied       []string
	deleted      []string
	pages        map[string]ObjectPage
	targetBucket string
}

func (f *fakeObjects) TargetBucket() string {
	if f.targetBucket != "" {
		return f.targetBucket
	}
	return "target-bucket"
}

func (f *fakeObjects) Copy(
	_ context.Context,
	_ uuid.UUID,
	_ LegacyAttachment,
	targetKey string,
) (CopiedObject, error) {
	if f.copyError != nil {
		return CopiedObject{}, f.copyError
	}
	f.copied = append(f.copied, targetKey)
	return CopiedObject{Size: 4, SHA256: "hash", ETag: "etag", Created: true}, nil
}

func (f *fakeObjects) Verify(_ context.Context, targetKey string, _ int64) (CopiedObject, error) {
	return CopiedObject{Size: 4, SHA256: "hash", ETag: "etag"}, nil
}

func (f *fakeObjects) Delete(_ context.Context, targetKey string) error {
	if f.deleteError != nil {
		return f.deleteError
	}
	f.deleted = append(f.deleted, targetKey)
	return nil
}

func (f *fakeObjects) List(
	_ context.Context,
	_ string,
	cursor string,
	_ int,
) (ObjectPage, error) {
	if page, ok := f.pages[cursor]; ok {
		return page, nil
	}
	return ObjectPage{}, nil
}

func sourceFixture(id uuid.UUID) LegacyAttachment {
	return LegacyAttachment{
		SourceFileID:       fileID,
		SourceAttachmentID: id,
		ProjectID:          projectID,
		TaskID:             taskID,
		SourceBucket:       "legacy-attachments",
		SourceKey:          "tasks/report.pdf",
		FileName:           "quarterly report.pdf",
		ContentType:        "application/pdf",
		Size:               4,
		CreatedAt:          time.Date(2026, 8, 1, 0, 0, 0, 0, time.UTC),
	}
}

func TestPlanIsDeterministicAndIdempotent(t *testing.T) {
	t.Parallel()
	source := &fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}}
	target := &fakeTarget{}
	service := New(source, target, &fakeObjects{})

	first, err := service.Plan(context.Background(), runID, 10)
	if err != nil {
		t.Fatalf("plan: %v", err)
	}
	second, err := service.Plan(context.Background(), runID, 10)
	if err != nil {
		t.Fatalf("repeat plan: %v", err)
	}
	if first.Planned != 1 || second.Planned != 0 || len(target.items) != 1 {
		t.Fatalf("unexpected plan results: first=%+v second=%+v items=%d", first, second, len(target.items))
	}
	item := target.items[0]
	if item.TargetFileID != attachmentID || item.TargetAttachmentID != attachmentID {
		t.Fatalf("target ids are not deterministic: %+v", item)
	}
	wantKey := "organizations/paca~2Fdefault/projects/" + projectID.String() +
		"/tasks/" + taskID.String() + "/attachments/" + attachmentID.String() +
		"/quarterly_report.pdf"
	if item.TargetStorageKey != wantKey {
		t.Fatalf("target key = %q, want %q", item.TargetStorageKey, wantKey)
	}
}

func TestPreviewDoesNotPersistMigrationLedger(t *testing.T) {
	t.Parallel()
	target := &fakeTarget{}
	service := New(
		&fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}},
		target,
		&fakeObjects{},
	)

	result, err := service.Preview(context.Background(), runID, 10)
	if err != nil {
		t.Fatalf("preview: %v", err)
	}
	if result.Planned != 1 || len(target.items) != 0 {
		t.Fatalf("preview wrote state: result=%+v items=%d", result, len(target.items))
	}
}

func TestPreviewReportsInvalidRowsWithoutPersistingThem(t *testing.T) {
	t.Parallel()
	invalid := sourceFixture(attachmentID)
	invalid.Size = 0
	target := &fakeTarget{}
	result, err := New(
		&fakeSource{items: []LegacyAttachment{invalid}},
		target,
		&fakeObjects{},
	).Preview(context.Background(), runID, 10)
	if err != nil {
		t.Fatalf("preview invalid row: %v", err)
	}
	if result.Skipped != 1 || len(result.Issues) != 1 ||
		result.Issues[0].Code != "SOURCE_METADATA_INVALID" || len(target.items) != 0 {
		t.Fatalf("invalid row was not reported safely: %+v", result)
	}
}

func TestPlanRejectsSourcePaginationThatDoesNotAdvance(t *testing.T) {
	t.Parallel()
	_, err := New(
		&stuckSource{item: sourceFixture(attachmentID)},
		&fakeTarget{},
		&fakeObjects{},
	).Preview(context.Background(), runID, 1)
	if err == nil || !strings.Contains(err.Error(), "pagination did not advance") {
		t.Fatalf("non-advancing source pagination was accepted: %v", err)
	}
}

func TestApplyPersistsCopyBeforeImportAndCanVerify(t *testing.T) {
	t.Parallel()
	source := &fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}}
	target := &fakeTarget{}
	objects := &fakeObjects{}
	service := New(source, target, objects)
	if _, err := service.Plan(context.Background(), runID, 10); err != nil {
		t.Fatalf("plan: %v", err)
	}

	result, err := service.Apply(context.Background(), runID)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if result.Succeeded != 1 || result.Failed != 0 || len(target.copied) != 1 || len(target.imported) != 1 {
		t.Fatalf("unexpected apply result: %+v", result)
	}
	verified, err := service.Verify(context.Background(), runID)
	if err != nil || verified.Succeeded != 1 || target.verifyMetadataCalled != 1 {
		t.Fatalf("verify: result=%+v err=%v calls=%d", verified, err, target.verifyMetadataCalled)
	}
}

func TestApplyFailureIsRecordedWithoutImportingMetadata(t *testing.T) {
	t.Parallel()
	source := &fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}}
	target := &fakeTarget{}
	service := New(source, target, &fakeObjects{copyError: errors.New("source unavailable")})
	_, _ = service.Plan(context.Background(), runID, 10)

	result, err := service.Apply(context.Background(), runID)
	if err != nil {
		t.Fatalf("apply: %v", err)
	}
	if result.Failed != 1 || len(target.imported) != 0 || target.failed[attachmentID] != "OBJECT_COPY_FAILED" {
		t.Fatalf("failure was not safely recorded: result=%+v failed=%v", result, target.failed)
	}
}

func TestApplyRejectsTargetBucketDifferentFromPersistedPlan(t *testing.T) {
	t.Parallel()
	source := &fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}}
	target := &fakeTarget{}
	objects := &fakeObjects{targetBucket: "wrong-bucket"}
	service := New(source, target, objects)
	_, _ = service.Plan(context.Background(), runID, 10)

	result, err := service.Apply(context.Background(), runID)
	if err != nil {
		t.Fatalf("apply bucket mismatch: %v", err)
	}
	if result.Failed != 1 || len(objects.copied) != 0 ||
		target.failed[attachmentID] != "TARGET_BUCKET_MISMATCH" {
		t.Fatalf("bucket mismatch was not rejected: result=%+v failed=%v", result, target.failed)
	}
}

func TestApplyRejectsSourceMetadataThatDriftedAfterPlan(t *testing.T) {
	t.Parallel()
	source := &fakeSource{items: []LegacyAttachment{sourceFixture(attachmentID)}}
	target := &fakeTarget{}
	objects := &fakeObjects{}
	service := New(source, target, objects)
	_, _ = service.Plan(context.Background(), runID, 10)
	source.items[0].SourceKey = "tasks/replaced.pdf"

	result, err := service.Apply(context.Background(), runID)
	if err != nil {
		t.Fatalf("apply drifted plan: %v", err)
	}
	if result.Failed != 1 || len(objects.copied) != 0 ||
		target.failed[attachmentID] != "SOURCE_PLAN_DRIFT" {
		t.Fatalf("source plan drift was not rejected: result=%+v failed=%v", result, target.failed)
	}
}

func TestVerifyCountsEveryNonImportedRunItemAsFailure(t *testing.T) {
	t.Parallel()
	failedID := uuid.MustParse("09bc2d4b-da22-4613-9888-6319af7cbc31")
	imported := sourceFixture(attachmentID)
	target := &fakeTarget{items: []PlannedItem{
		{
			RunID:              runID,
			SourceBucket:       imported.SourceBucket,
			SourceKey:          imported.SourceKey,
			SourceFileID:       imported.SourceFileID,
			SourceAttachmentID: imported.SourceAttachmentID,
			TargetFileID:       imported.SourceAttachmentID,
			TargetAttachmentID: imported.SourceAttachmentID,
			TargetBucket:       "target-bucket",
			TargetStorageKey: canonicalStorageKey(
				"paca/default",
				imported.ProjectID,
				imported.TaskID,
				imported.SourceAttachmentID,
				imported.FileName,
			),
			SourceSize: imported.Size,
			Status:     "imported",
			SHA256:     "hash",
		},
		{RunID: runID, SourceAttachmentID: failedID, Status: "failed"},
	}}
	service := New(&fakeSource{items: []LegacyAttachment{imported}}, target, &fakeObjects{})

	result, err := service.Verify(context.Background(), runID)
	if err != nil {
		t.Fatalf("verify mixed run: %v", err)
	}
	if result.Succeeded != 1 || result.Failed != 1 || target.verifyMetadataCalled != 1 {
		t.Fatalf("verify ignored a non-imported item: result=%+v calls=%d", result, target.verifyMetadataCalled)
	}
}

func TestVerifyRejectsUnknownOrEmptyRun(t *testing.T) {
	t.Parallel()
	_, err := New(&fakeSource{}, &fakeTarget{}, &fakeObjects{}).
		Verify(context.Background(), runID)
	if err == nil || !strings.Contains(err.Error(), "run has no planned items") {
		t.Fatalf("empty migration run was accepted: %v", err)
	}
}

func TestRollbackFailureRemainsRollbackWorkAndNeverBecomesApplyWork(t *testing.T) {
	t.Parallel()
	item := PlannedItem{
		RunID:              runID,
		SourceAttachmentID: attachmentID,
		TargetStorageKey:   "organizations/test/object",
		TargetBucket:       "target-bucket",
		Status:             "imported",
		OwnsTargetObject:   true,
	}
	target := &fakeTarget{items: []PlannedItem{item}}
	service := New(&fakeSource{}, target, &fakeObjects{deleteError: errors.New("R2 unavailable")})

	result, err := service.Rollback(context.Background(), runID, time.Now())
	if err != nil {
		t.Fatalf("rollback: %v", err)
	}
	if result.Failed != 1 || target.rollbackFailed[attachmentID] != "ROLLBACK_OBJECT_DELETE_FAILED" {
		t.Fatalf("rollback failure was not recorded: result=%+v failures=%v", result, target.rollbackFailed)
	}
	applyItems, _ := target.ListRun(context.Background(), runID, []string{"planned", "copied", "failed"})
	if len(applyItems) != 0 {
		t.Fatalf("rollback failure leaked back into apply work: %+v", applyItems)
	}
}

func TestRollbackCleansObjectOwnedByFailedImport(t *testing.T) {
	t.Parallel()
	item := PlannedItem{
		RunID:              runID,
		SourceAttachmentID: attachmentID,
		TargetStorageKey:   "organizations/test/object",
		TargetBucket:       "target-bucket",
		Status:             "failed",
		OwnsTargetObject:   true,
	}
	target := &fakeTarget{items: []PlannedItem{item}}
	objects := &fakeObjects{}
	result, err := New(&fakeSource{}, target, objects).
		Rollback(context.Background(), runID, time.Now())
	if err != nil {
		t.Fatalf("rollback failed import: %v", err)
	}
	if result.Succeeded != 1 || len(objects.deleted) != 1 || len(target.rolledBack) != 1 {
		t.Fatalf("failed import ownership was not rolled back: result=%+v deleted=%v", result, objects.deleted)
	}
}

func TestOrphanAuditOnlyDeletesOldCanonicalUnreferencedObjects(t *testing.T) {
	t.Parallel()
	cutoff := time.Date(2026, 8, 28, 0, 0, 0, 0, time.UTC)
	canonical := "organizations/default/projects/" + projectID.String() + "/tasks/" +
		taskID.String() + "/attachments/" + attachmentID.String() + "/report.pdf"
	known := strings.Replace(canonical, "report.pdf", "known.pdf", 1)
	newObject := strings.Replace(canonical, "report.pdf", "new.pdf", 1)
	nonTask := "organizations/default/projects/" + projectID.String() + "/docs/file.bin"
	target := &fakeTarget{knownKeys: map[string]bool{known: true}}
	objects := &fakeObjects{pages: map[string]ObjectPage{
		"": {
			Items: []StoredObject{
				{Key: canonical, Size: 4, LastModified: cutoff.Add(-time.Hour)},
				{Key: known, Size: 5, LastModified: cutoff.Add(-time.Hour)},
				{Key: newObject, Size: 6, LastModified: cutoff.Add(time.Hour)},
				{Key: nonTask, Size: 7, LastModified: cutoff.Add(-time.Hour)},
			},
		},
	}}
	service := New(&fakeSource{}, target, objects)

	result, err := service.AuditOrphans(context.Background(), cutoff, true)
	if err != nil {
		t.Fatalf("audit orphans: %v", err)
	}
	if result.Scanned != 4 || result.Eligible != 2 || result.Orphans != 1 ||
		result.Deleted != 1 || result.OrphanBytes != 4 {
		t.Fatalf("unexpected orphan audit result: %+v", result)
	}
	if len(objects.deleted) != 1 || objects.deleted[0] != canonical {
		t.Fatalf("unexpected deleted objects: %v", objects.deleted)
	}
}
