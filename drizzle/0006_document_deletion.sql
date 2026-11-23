ALTER TABLE "app"."sop_documents" DROP CONSTRAINT "sop_documents_status";--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "deleted_by" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_state" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_error_code" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_next_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_lease_token" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_lease_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "cleanup_completed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_deleted_by_auth_users_id_fk" FOREIGN KEY ("deleted_by") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sop_documents_cleanup_due" ON "app"."sop_documents" USING btree ("status","cleanup_state","cleanup_next_at");--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_cleanup_attempts" CHECK ("app"."sop_documents"."cleanup_attempts" >= 0);--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_deletion_binding" CHECK (("app"."sop_documents"."status" = 'DELETED' and "app"."sop_documents"."deleted_by" is not null and "app"."sop_documents"."deleted_at" is not null and "app"."sop_documents"."cleanup_state" in ('PENDING','RUNNING','COMPLETED','FAILED') and "app"."sop_documents"."active_job_id" is null and "app"."sop_documents"."active_pipeline_version" is null and "app"."sop_documents"."active_attempt_id" is null and "app"."sop_documents"."rejection_reason" is null) or ("app"."sop_documents"."status" <> 'DELETED' and "app"."sop_documents"."deleted_by" is null and "app"."sop_documents"."deleted_at" is null and "app"."sop_documents"."cleanup_state" is null and "app"."sop_documents"."cleanup_error_code" is null and "app"."sop_documents"."cleanup_next_at" is null and "app"."sop_documents"."cleanup_lease_token" is null and "app"."sop_documents"."cleanup_lease_until" is null and "app"."sop_documents"."cleanup_completed_at" is null));--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_status" CHECK ("app"."sop_documents"."status" in ('UPLOADED','PROCESSING','PENDING_VERIFICATION','ACTIVE','REJECTED','FAILED','DELETED'));
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_sop_document_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  chunk_total integer;
  invalid_embedding_total integer;
BEGIN
  IF OLD.status = 'DELETED' THEN
    IF NEW.status IS DISTINCT FROM 'DELETED'
      OR NEW.deleted_by IS DISTINCT FROM OLD.deleted_by
      OR NEW.deleted_at IS DISTINCT FROM OLD.deleted_at
      OR NEW.active_job_id IS DISTINCT FROM OLD.active_job_id
      OR NEW.active_pipeline_version IS DISTINCT FROM OLD.active_pipeline_version
      OR NEW.active_attempt_id IS DISTINCT FROM OLD.active_attempt_id
      OR NEW.processed_job_id IS DISTINCT FROM OLD.processed_job_id
      OR NEW.processed_pipeline_version IS DISTINCT FROM OLD.processed_pipeline_version
      OR NEW.processed_attempt_id IS DISTINCT FROM OLD.processed_attempt_id
      OR NEW.verified_by IS DISTINCT FROM OLD.verified_by
      OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
      OR NEW.rejection_reason IS DISTINCT FROM OLD.rejection_reason
      OR NEW.title IS DISTINCT FROM OLD.title
      OR NEW.file_name IS DISTINCT FROM OLD.file_name
      OR NEW.latest_job_id IS DISTINCT FROM OLD.latest_job_id
      OR NEW.processing_error_code IS DISTINCT FROM OLD.processing_error_code
      OR (NEW.preview_key IS NOT NULL AND NEW.preview_key IS DISTINCT FROM OLD.preview_key)
    THEN
      RAISE EXCEPTION 'DELETED SOP tombstones cannot be revived or altered outside cleanup reconciliation' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'DELETED' THEN
    IF NOT EXISTS (
      SELECT 1 FROM app.auth_users u
      WHERE u.id = NEW.deleted_by
        AND u.role = 'ADMIN'
        AND u.active = true
    ) THEN
      RAISE EXCEPTION 'Deletion requires an active Admin actor' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD.status = 'ACTIVE' THEN
    RAISE EXCEPTION 'ACTIVE SOP documents cannot be mutated in place; replacement is D6/P1' USING ERRCODE = '23514';
  END IF;

  IF NEW.status = 'ACTIVE' THEN
    IF OLD.status <> 'PENDING_VERIFICATION' THEN
      RAISE EXCEPTION 'Only PENDING_VERIFICATION documents may be activated' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM app.auth_users u
      WHERE u.id = NEW.verified_by
        AND u.role = 'ADMIN'
        AND u.active = true
    ) THEN
      RAISE EXCEPTION 'Activation requires an active Admin verifier' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM app.workflow_jobs j
      WHERE j.id = NEW.active_job_id
        AND j.kind = 'document_ingestion'
        AND j.state = 'COMPLETED'
        AND j.document_id = NEW.id
        AND j.source_sha256 = NEW.sha256
        AND j.pipeline_version = NEW.active_pipeline_version
        AND j.attempt_id = NEW.active_attempt_id
    ) THEN
      RAISE EXCEPTION 'Activation requires a matching completed ingestion attempt' USING ERRCODE = '23514';
    END IF;

    SELECT
      count(*)::int,
      count(*) FILTER (WHERE embedding IS NULL OR embedding_dimensions IS DISTINCT FROM 1536)::int
    INTO chunk_total, invalid_embedding_total
    FROM app.sop_chunks c
    WHERE c.job_id = NEW.active_job_id
      AND c.document_id = NEW.id
      AND c.source_sha256 = NEW.sha256
      AND c.pipeline_version = NEW.active_pipeline_version;

    IF chunk_total < 1 OR invalid_embedding_total > 0 THEN
      RAISE EXCEPTION 'Activation requires nonempty chunks with valid 1536-dim embeddings' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM app.sop_verification_records r
      WHERE r.document_id = NEW.id
        AND r.source_sha256 = NEW.sha256
        AND r.job_id = NEW.active_job_id
        AND r.pipeline_version = NEW.active_pipeline_version
        AND r.attempt_id = NEW.active_attempt_id
        AND r.reviewer_id = NEW.verified_by
        AND r.decision = 'APPROVED'
        AND r.after_status = 'ACTIVE'
        AND r.created_at >= OLD.updated_at
    ) THEN
      RAISE EXCEPTION 'Activation requires a matching approved verification record' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.status = 'REJECTED' THEN
    IF OLD.status <> 'PENDING_VERIFICATION' THEN
      RAISE EXCEPTION 'Only PENDING_VERIFICATION documents may be rejected' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM app.auth_users u
      WHERE u.id = NEW.verified_by
        AND u.role = 'ADMIN'
        AND u.active = true
    ) THEN
      RAISE EXCEPTION 'Rejection requires an active Admin reviewer' USING ERRCODE = '23514';
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM app.sop_verification_records r
      WHERE r.document_id = NEW.id
        AND r.source_sha256 = NEW.sha256
        AND r.job_id = NEW.processed_job_id
        AND r.pipeline_version = NEW.processed_pipeline_version
        AND r.attempt_id = NEW.processed_attempt_id
        AND r.reviewer_id = NEW.verified_by
        AND r.decision = 'REJECTED'
        AND r.after_status = 'REJECTED'
        AND r.created_at >= OLD.updated_at
    ) THEN
      RAISE EXCEPTION 'Rejection requires a matching rejected verification record' USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.block_deleted_document_artifacts() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.sop_documents d
    WHERE d.id = NEW.document_id
      AND d.status = 'DELETED'
  ) THEN
    RAISE EXCEPTION 'Artifacts cannot be inserted or updated for a DELETED SOP document' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_chunks_block_deleted BEFORE INSERT OR UPDATE ON app.sop_chunks
FOR EACH ROW EXECUTE FUNCTION app.block_deleted_document_artifacts();
--> statement-breakpoint
CREATE TRIGGER sop_extraction_pages_block_deleted BEFORE INSERT OR UPDATE ON app.sop_extraction_pages
FOR EACH ROW EXECUTE FUNCTION app.block_deleted_document_artifacts();
--> statement-breakpoint
CREATE TRIGGER sop_verification_issues_block_deleted BEFORE INSERT OR UPDATE ON app.sop_verification_issues
FOR EACH ROW EXECUTE FUNCTION app.block_deleted_document_artifacts();
--> statement-breakpoint
CREATE TRIGGER sop_verification_records_block_deleted BEFORE INSERT OR UPDATE ON app.sop_verification_records
FOR EACH ROW EXECUTE FUNCTION app.block_deleted_document_artifacts();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.block_deleted_document_artifacts() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.block_deleted_document_artifacts() TO sop_runtime;
--> statement-breakpoint
GRANT UPDATE (deleted_by, deleted_at, cleanup_state, cleanup_attempts, cleanup_error_code, cleanup_next_at, cleanup_lease_token, cleanup_lease_until, cleanup_completed_at) ON app.sop_documents TO sop_runtime;
