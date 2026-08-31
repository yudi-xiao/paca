package attachmentmigration

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/aws/aws-sdk-go-v2/aws"
	awsconfig "github.com/aws/aws-sdk-go-v2/config"
	"github.com/aws/aws-sdk-go-v2/credentials"
	"github.com/aws/aws-sdk-go-v2/service/s3"
	"github.com/aws/smithy-go"
	smithyhttp "github.com/aws/smithy-go/transport/http"
	"github.com/google/uuid"
)

type S3EndpointConfig struct {
	Endpoint        string
	Region          string
	AccessKeyID     string
	SecretAccessKey string
	ForcePathStyle  bool
}

type MigrationObjectStore struct {
	source        *s3.Client
	target        *s3.Client
	targetBucket  string
	tempDirectory string
}

func (s *MigrationObjectStore) TargetBucket() string {
	return s.targetBucket
}

func NewMigrationObjectStore(
	ctx context.Context,
	sourceConfig, targetConfig S3EndpointConfig,
	targetBucket, tempDirectory string,
) (*MigrationObjectStore, error) {
	store, err := NewTargetMigrationObjectStore(ctx, targetConfig, targetBucket, tempDirectory)
	if err != nil {
		return nil, err
	}
	source, err := newS3Client(ctx, sourceConfig)
	if err != nil {
		return nil, fmt.Errorf("attachment migration objects: source client: %w", err)
	}
	store.source = source
	return store, nil
}

func NewTargetMigrationObjectStore(
	ctx context.Context,
	targetConfig S3EndpointConfig,
	targetBucket, tempDirectory string,
) (*MigrationObjectStore, error) {
	target, err := newS3Client(ctx, targetConfig)
	if err != nil {
		return nil, fmt.Errorf("attachment migration objects: target client: %w", err)
	}
	if strings.TrimSpace(targetBucket) == "" {
		return nil, errors.New("attachment migration objects: target bucket is required")
	}
	if tempDirectory == "" {
		tempDirectory = os.TempDir()
	}
	return &MigrationObjectStore{
		target:        target,
		targetBucket:  targetBucket,
		tempDirectory: tempDirectory,
	}, nil
}

func newS3Client(ctx context.Context, config S3EndpointConfig) (*s3.Client, error) {
	if strings.TrimSpace(config.Region) == "" || strings.TrimSpace(config.AccessKeyID) == "" ||
		strings.TrimSpace(config.SecretAccessKey) == "" {
		return nil, errors.New("region and static credentials are required")
	}
	loaded, err := awsconfig.LoadDefaultConfig(
		ctx,
		awsconfig.WithRegion(config.Region),
		awsconfig.WithCredentialsProvider(credentials.NewStaticCredentialsProvider(
			config.AccessKeyID,
			config.SecretAccessKey,
			"",
		)),
	)
	if err != nil {
		return nil, fmt.Errorf("load config: %w", err)
	}
	return s3.NewFromConfig(loaded, func(options *s3.Options) {
		if config.Endpoint != "" {
			options.BaseEndpoint = aws.String(config.Endpoint)
		}
		options.UsePathStyle = config.ForcePathStyle
	}), nil
}

func (s *MigrationObjectStore) Copy(
	ctx context.Context,
	runID uuid.UUID,
	source LegacyAttachment,
	targetKey string,
) (CopiedObject, error) {
	if s.source == nil {
		return CopiedObject{}, errors.New("attachment migration objects: source client is unavailable")
	}
	head, err := s.source.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(source.SourceBucket),
		Key:    aws.String(source.SourceKey),
	})
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: head source: %w", err)
	}
	if aws.ToInt64(head.ContentLength) != source.Size {
		return CopiedObject{}, errors.New("attachment migration objects: source size differs from metadata")
	}

	temporary, err := os.CreateTemp(s.tempDirectory, "paca-attachment-migration-*")
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: create temporary file: %w", err)
	}
	temporaryName := temporary.Name()
	defer func() {
		_ = temporary.Close()
		_ = os.Remove(temporaryName)
	}()

	sourceObject, err := s.source.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(source.SourceBucket),
		Key:    aws.String(source.SourceKey),
	})
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: get source: %w", err)
	}
	hash := sha256.New()
	written, copyErr := io.Copy(
		io.MultiWriter(temporary, hash),
		io.LimitReader(sourceObject.Body, MaxAttachmentSize+1),
	)
	closeErr := sourceObject.Body.Close()
	if copyErr != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: spool source: %w", copyErr)
	}
	if closeErr != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: close source: %w", closeErr)
	}
	if written != source.Size {
		return CopiedObject{}, errors.New("attachment migration objects: downloaded source size mismatch")
	}
	checksum := hex.EncodeToString(hash.Sum(nil))

	existing, err := s.verifyIfPresent(ctx, targetKey, source.Size)
	if err != nil {
		return CopiedObject{}, err
	}
	if existing != nil {
		if existing.SHA256 != checksum {
			return CopiedObject{}, errors.New("attachment migration objects: conflicting target object")
		}
		return s.withExistingOwnership(ctx, runID, source.SourceAttachmentID, targetKey, *existing)
	}

	if _, err := temporary.Seek(0, io.SeekStart); err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: rewind temporary file: %w", err)
	}
	_, err = s.target.PutObject(ctx, &s3.PutObjectInput{
		Bucket:        aws.String(s.targetBucket),
		Key:           aws.String(targetKey),
		Body:          temporary,
		ContentLength: aws.Int64(source.Size),
		ContentType:   aws.String(normalizedContentType(source.ContentType)),
		IfNoneMatch:   aws.String("*"),
		Metadata: map[string]string{
			"paca-migration-run-id":     runID.String(),
			"paca-source-file-id":       source.SourceFileID.String(),
			"paca-source-attachment-id": source.SourceAttachmentID.String(),
		},
	})
	if err != nil {
		if isConditionalConflict(err) {
			existing, verifyErr := s.Verify(ctx, targetKey, source.Size)
			if verifyErr != nil {
				return CopiedObject{}, fmt.Errorf(
					"attachment migration objects: conditional target create conflicted: %w",
					err,
				)
			}
			if existing.SHA256 != checksum {
				return CopiedObject{}, errors.New("attachment migration objects: conflicting target object")
			}
			return s.withExistingOwnership(
				ctx,
				runID,
				source.SourceAttachmentID,
				targetKey,
				existing,
			)
		}
		return CopiedObject{}, fmt.Errorf("attachment migration objects: put target: %w", err)
	}
	verified, err := s.Verify(ctx, targetKey, source.Size)
	if err != nil {
		return CopiedObject{}, err
	}
	if verified.SHA256 != checksum || verified.Size != source.Size {
		return CopiedObject{}, errors.New("attachment migration objects: target verification mismatch")
	}
	verified.Created = true
	return verified, nil
}

func (s *MigrationObjectStore) withExistingOwnership(
	ctx context.Context,
	runID, sourceAttachmentID uuid.UUID,
	targetKey string,
	existing CopiedObject,
) (CopiedObject, error) {
	head, err := s.target.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.targetBucket),
		Key:    aws.String(targetKey),
	})
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: re-read target metadata: %w", err)
	}
	existing.Created = head.Metadata["paca-migration-run-id"] == runID.String() &&
		head.Metadata["paca-source-attachment-id"] == sourceAttachmentID.String()
	return existing, nil
}

func (s *MigrationObjectStore) Verify(
	ctx context.Context,
	targetKey string,
	maxBytes int64,
) (CopiedObject, error) {
	if maxBytes < 1 || maxBytes > MaxAttachmentSize {
		return CopiedObject{}, errors.New("attachment migration objects: invalid verification bound")
	}
	head, err := s.target.HeadObject(ctx, &s3.HeadObjectInput{
		Bucket: aws.String(s.targetBucket),
		Key:    aws.String(targetKey),
	})
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: head target: %w", err)
	}
	size := aws.ToInt64(head.ContentLength)
	if size < 1 || size > maxBytes {
		return CopiedObject{}, errors.New("attachment migration objects: target size outside verification bound")
	}
	object, err := s.target.GetObject(ctx, &s3.GetObjectInput{
		Bucket: aws.String(s.targetBucket),
		Key:    aws.String(targetKey),
	})
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: get target: %w", err)
	}
	defer func() { _ = object.Body.Close() }()
	hash := sha256.New()
	written, err := io.Copy(hash, io.LimitReader(object.Body, maxBytes+1))
	if err != nil {
		return CopiedObject{}, fmt.Errorf("attachment migration objects: hash target: %w", err)
	}
	if written != size {
		return CopiedObject{}, errors.New("attachment migration objects: target body size mismatch")
	}
	return CopiedObject{
		Size:   size,
		SHA256: hex.EncodeToString(hash.Sum(nil)),
		ETag:   normalizedETag(aws.ToString(head.ETag)),
	}, nil
}

func (s *MigrationObjectStore) verifyIfPresent(
	ctx context.Context,
	targetKey string,
	maxBytes int64,
) (*CopiedObject, error) {
	verified, err := s.Verify(ctx, targetKey, maxBytes)
	if err == nil {
		return &verified, nil
	}
	if isNotFound(err) {
		return nil, nil
	}
	return nil, err
}

func (s *MigrationObjectStore) Delete(ctx context.Context, targetKey string) error {
	_, err := s.target.DeleteObject(ctx, &s3.DeleteObjectInput{
		Bucket: aws.String(s.targetBucket),
		Key:    aws.String(targetKey),
	})
	if err != nil {
		return fmt.Errorf("attachment migration objects: delete target: %w", err)
	}
	return nil
}

func (s *MigrationObjectStore) List(
	ctx context.Context,
	prefix, cursor string,
	limit int,
) (ObjectPage, error) {
	if limit < 1 || limit > 1000 {
		return ObjectPage{}, errors.New("attachment migration objects: list limit must be between 1 and 1000")
	}
	input := &s3.ListObjectsV2Input{
		Bucket:  aws.String(s.targetBucket),
		Prefix:  aws.String(prefix),
		MaxKeys: aws.Int32(int32(limit)),
	}
	if cursor != "" {
		input.ContinuationToken = aws.String(cursor)
	}
	page, err := s.target.ListObjectsV2(ctx, input)
	if err != nil {
		return ObjectPage{}, fmt.Errorf("attachment migration objects: list target: %w", err)
	}
	result := ObjectPage{Items: make([]StoredObject, 0, len(page.Contents))}
	for _, object := range page.Contents {
		if object.Key == nil || object.LastModified == nil {
			continue
		}
		result.Items = append(result.Items, StoredObject{
			Key:          aws.ToString(object.Key),
			Size:         aws.ToInt64(object.Size),
			LastModified: aws.ToTime(object.LastModified),
		})
	}
	if aws.ToBool(page.IsTruncated) {
		result.NextCursor = aws.ToString(page.NextContinuationToken)
		if result.NextCursor == "" {
			return ObjectPage{}, errors.New("attachment migration objects: truncated page has no cursor")
		}
	}
	return result, nil
}

func normalizedContentType(value string) string {
	if strings.TrimSpace(value) == "" {
		return "application/octet-stream"
	}
	return strings.TrimSpace(value)
}

func normalizedETag(value string) string {
	return strings.Trim(value, `"`)
}

func isNotFound(err error) bool {
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) && responseError.HTTPStatusCode() == 404 {
		return true
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		return apiError.ErrorCode() == "NotFound" || apiError.ErrorCode() == "NoSuchKey"
	}
	return false
}

func isConditionalConflict(err error) bool {
	var responseError *smithyhttp.ResponseError
	if errors.As(err, &responseError) {
		status := responseError.HTTPStatusCode()
		if status == 409 || status == 412 {
			return true
		}
	}
	var apiError smithy.APIError
	if errors.As(err, &apiError) {
		return apiError.ErrorCode() == "PreconditionFailed" ||
			apiError.ErrorCode() == "ConditionalRequestConflict"
	}
	return false
}
