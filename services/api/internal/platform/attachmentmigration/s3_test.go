package attachmentmigration

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/google/uuid"
)

func TestCopyCreatesTargetConditionally(t *testing.T) {
	t.Parallel()
	const body = "data"
	var mutex sync.Mutex
	targetExists := false
	targetBody := ""
	targetMetadata := map[string]string{}
	conditionalHeader := ""

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		switch {
		case request.URL.Path == "/legacy/tasks/report.pdf" && request.Method == http.MethodHead:
			response.Header().Set("Content-Length", fmt.Sprint(len(body)))
			response.Header().Set("ETag", `"source-etag"`)
			response.WriteHeader(http.StatusOK)
		case request.URL.Path == "/legacy/tasks/report.pdf" && request.Method == http.MethodGet:
			response.Header().Set("Content-Length", fmt.Sprint(len(body)))
			response.Header().Set("ETag", `"source-etag"`)
			_, _ = io.WriteString(response, body)
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodHead:
			if !targetExists {
				writeS3Error(response, http.StatusNotFound, "NoSuchKey")
				return
			}
			writeTargetHead(response, targetBody, targetMetadata)
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodGet:
			if !targetExists {
				writeS3Error(response, http.StatusNotFound, "NoSuchKey")
				return
			}
			writeTargetHead(response, targetBody, targetMetadata)
			_, _ = io.WriteString(response, targetBody)
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodPut:
			conditionalHeader = request.Header.Get("If-None-Match")
			read, err := io.ReadAll(request.Body)
			if err != nil {
				t.Errorf("read target request: %v", err)
				writeS3Error(response, http.StatusBadRequest, "InvalidRequest")
				return
			}
			targetExists = true
			targetBody = string(read)
			targetMetadata = map[string]string{
				"paca-migration-run-id":     request.Header.Get("x-amz-meta-paca-migration-run-id"),
				"paca-source-attachment-id": request.Header.Get("x-amz-meta-paca-source-attachment-id"),
			}
			response.Header().Set("ETag", `"target-etag"`)
			response.WriteHeader(http.StatusOK)
		default:
			t.Errorf("unexpected S3 request: %s %s", request.Method, request.URL.String())
			writeS3Error(response, http.StatusNotFound, "NoSuchKey")
		}
	}))
	defer server.Close()

	config := S3EndpointConfig{
		Endpoint:        server.URL,
		Region:          "us-east-1",
		AccessKeyID:     "test-access-key",
		SecretAccessKey: "test-secret-key",
		ForcePathStyle:  true,
	}
	store, err := NewMigrationObjectStore(context.Background(), config, config, "target", t.TempDir())
	if err != nil {
		t.Fatalf("create object store: %v", err)
	}
	source := sourceFixture(attachmentID)
	source.SourceBucket = "legacy"
	source.SourceKey = "tasks/report.pdf"
	copied, err := store.Copy(context.Background(), runID, source, "target/key")
	if err != nil {
		t.Fatalf("copy object: %v", err)
	}
	if conditionalHeader != "*" {
		t.Fatalf("target PUT If-None-Match = %q, want *", conditionalHeader)
	}
	if !copied.Created || copied.Size != int64(len(body)) || targetBody != body {
		t.Fatalf("unexpected copied object: copied=%+v body=%q", copied, targetBody)
	}
}

func TestConditionalCopyConflictReusesMatchingObjectWithoutClaimingOwnership(t *testing.T) {
	t.Parallel()
	const body = "data"
	var mutex sync.Mutex
	targetVisible := false
	putCalls := 0

	server := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		mutex.Lock()
		defer mutex.Unlock()
		switch {
		case request.URL.Path == "/legacy/tasks/report.pdf" && request.Method == http.MethodHead:
			response.Header().Set("Content-Length", fmt.Sprint(len(body)))
			response.Header().Set("ETag", `"source-etag"`)
			response.WriteHeader(http.StatusOK)
		case request.URL.Path == "/legacy/tasks/report.pdf" && request.Method == http.MethodGet:
			response.Header().Set("Content-Length", fmt.Sprint(len(body)))
			_, _ = io.WriteString(response, body)
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodHead:
			if !targetVisible {
				writeS3Error(response, http.StatusNotFound, "NoSuchKey")
				return
			}
			writeTargetHead(response, body, map[string]string{
				"paca-migration-run-id":     uuid.NewString(),
				"paca-source-attachment-id": attachmentID.String(),
			})
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodGet:
			writeTargetHead(response, body, nil)
			_, _ = io.WriteString(response, body)
		case request.URL.Path == "/target/target/key" && request.Method == http.MethodPut:
			putCalls++
			if request.Header.Get("If-None-Match") != "*" {
				t.Errorf("conditional target PUT did not use If-None-Match")
			}
			targetVisible = true
			writeS3Error(response, http.StatusPreconditionFailed, "PreconditionFailed")
		default:
			t.Errorf("unexpected S3 request: %s %s", request.Method, request.URL.String())
			writeS3Error(response, http.StatusNotFound, "NoSuchKey")
		}
	}))
	defer server.Close()

	config := S3EndpointConfig{
		Endpoint:        server.URL,
		Region:          "us-east-1",
		AccessKeyID:     "test-access-key",
		SecretAccessKey: "test-secret-key",
		ForcePathStyle:  true,
	}
	store, err := NewMigrationObjectStore(context.Background(), config, config, "target", t.TempDir())
	if err != nil {
		t.Fatalf("create object store: %v", err)
	}
	source := sourceFixture(attachmentID)
	source.SourceBucket = "legacy"
	source.SourceKey = "tasks/report.pdf"
	copied, err := store.Copy(context.Background(), runID, source, "target/key")
	if err != nil {
		t.Fatalf("copy after conditional conflict: %v", err)
	}
	if putCalls != 1 || copied.Created || copied.Size != int64(len(body)) {
		t.Fatalf("conflicting matching object ownership is unsafe: calls=%d copied=%+v", putCalls, copied)
	}
}

func writeTargetHead(response http.ResponseWriter, body string, metadata map[string]string) {
	response.Header().Set("Content-Length", fmt.Sprint(len(body)))
	response.Header().Set("ETag", `"target-etag"`)
	for key, value := range metadata {
		response.Header().Set("x-amz-meta-"+key, value)
	}
	response.WriteHeader(http.StatusOK)
}

func writeS3Error(response http.ResponseWriter, status int, code string) {
	response.Header().Set("Content-Type", "application/xml")
	response.WriteHeader(status)
	_, _ = io.WriteString(
		response,
		`<Error><Code>`+code+`</Code><Message>`+strings.ReplaceAll(code, "_", " ")+`</Message></Error>`,
	)
}
