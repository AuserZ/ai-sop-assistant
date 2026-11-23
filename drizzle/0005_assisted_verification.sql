CREATE TABLE "app"."sop_verification_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"source_sha256" text NOT NULL,
	"job_id" uuid NOT NULL,
	"pipeline_version" text NOT NULL,
	"attempt_id" uuid NOT NULL,
	"reviewer_id" text NOT NULL,
	"decision" text NOT NULL,
	"notes" text,
	"issue_summary" jsonb NOT NULL,
	"before_status" text NOT NULL,
	"after_status" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_verification_records_sha256" CHECK ("app"."sop_verification_records"."source_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sop_verification_records_decision" CHECK ("app"."sop_verification_records"."decision" in ('APPROVED','REJECTED')),
	CONSTRAINT "sop_verification_records_notes" CHECK ("app"."sop_verification_records"."decision" = 'APPROVED' or ("app"."sop_verification_records"."notes" is not null and length(btrim("app"."sop_verification_records"."notes")) > 0)),
	CONSTRAINT "sop_verification_records_before_status" CHECK ("app"."sop_verification_records"."before_status" = 'PENDING_VERIFICATION'),
	CONSTRAINT "sop_verification_records_transition" CHECK (("app"."sop_verification_records"."decision" = 'APPROVED' and "app"."sop_verification_records"."after_status" = 'ACTIVE') or ("app"."sop_verification_records"."decision" = 'REJECTED' and "app"."sop_verification_records"."after_status" = 'REJECTED'))
);
--> statement-breakpoint
ALTER TABLE "app"."sop_documents" DROP CONSTRAINT "sop_documents_status";--> statement-breakpoint
ALTER TABLE "app"."sop_extraction_pages" DROP CONSTRAINT "sop_extraction_pages_unverified";--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "processed_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "active_job_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "active_pipeline_version" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "active_attempt_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "verified_by" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "verified_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "rejection_reason" text;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_records" ADD CONSTRAINT "sop_verification_records_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_records" ADD CONSTRAINT "sop_verification_records_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_records" ADD CONSTRAINT "sop_verification_records_reviewer_id_auth_users_id_fk" FOREIGN KEY ("reviewer_id") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sop_verification_records_document_created" ON "app"."sop_verification_records" USING btree ("document_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_active_job_id_workflow_jobs_id_fk" FOREIGN KEY ("active_job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_verified_by_auth_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sop_documents_status_verified" ON "app"."sop_documents" USING btree ("status","verified_at");--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_activation_binding" CHECK (("app"."sop_documents"."status" = 'ACTIVE' and "app"."sop_documents"."active_job_id" is not null and "app"."sop_documents"."active_pipeline_version" is not null and "app"."sop_documents"."active_attempt_id" is not null and "app"."sop_documents"."processed_job_id" = "app"."sop_documents"."active_job_id" and "app"."sop_documents"."processed_pipeline_version" = "app"."sop_documents"."active_pipeline_version" and "app"."sop_documents"."processed_attempt_id" = "app"."sop_documents"."active_attempt_id" and "app"."sop_documents"."verified_by" is not null and "app"."sop_documents"."verified_at" is not null and "app"."sop_documents"."rejection_reason" is null) or ("app"."sop_documents"."status" <> 'ACTIVE' and "app"."sop_documents"."active_job_id" is null and "app"."sop_documents"."active_pipeline_version" is null and "app"."sop_documents"."active_attempt_id" is null));--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_rejection_binding" CHECK (("app"."sop_documents"."status" = 'REJECTED' and "app"."sop_documents"."verified_by" is not null and "app"."sop_documents"."verified_at" is not null and "app"."sop_documents"."rejection_reason" is not null and length(btrim("app"."sop_documents"."rejection_reason")) > 0) or ("app"."sop_documents"."status" <> 'REJECTED' and "app"."sop_documents"."rejection_reason" is null));--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_status" CHECK ("app"."sop_documents"."status" in ('UPLOADED','PROCESSING','PENDING_VERIFICATION','ACTIVE','REJECTED','FAILED'));--> statement-breakpoint
ALTER TABLE "app"."sop_extraction_pages" ADD CONSTRAINT "sop_extraction_pages_unverified" CHECK ("app"."sop_extraction_pages"."verification_status" in ('UNVERIFIED','APPROVED','REJECTED'));
--> statement-breakpoint
CREATE FUNCTION app.enforce_sop_verification_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.auth_users u
    WHERE u.id = NEW.reviewer_id
      AND u.role = 'ADMIN'
      AND u.active = true
  ) THEN
    RAISE EXCEPTION 'Verification record requires an active Admin reviewer' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.workflow_jobs j
    WHERE j.id = NEW.job_id
      AND j.kind = 'document_ingestion'
      AND j.state = 'COMPLETED'
      AND j.document_id = NEW.document_id
      AND j.source_sha256 = NEW.source_sha256
      AND j.pipeline_version = NEW.pipeline_version
      AND j.attempt_id = NEW.attempt_id
  ) THEN
    RAISE EXCEPTION 'Verification record must bind to a completed document_ingestion attempt' USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM app.sop_documents d
    WHERE d.id = NEW.document_id
      AND d.sha256 = NEW.source_sha256
      AND d.status = 'PENDING_VERIFICATION'
      AND d.processed_job_id = NEW.job_id
      AND d.processed_pipeline_version = NEW.pipeline_version
      AND d.processed_attempt_id = NEW.attempt_id
  ) THEN
    RAISE EXCEPTION 'Verification record requires a matching PENDING_VERIFICATION document snapshot' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_verification_records_enforce BEFORE INSERT ON app.sop_verification_records
FOR EACH ROW EXECUTE FUNCTION app.enforce_sop_verification_record();
--> statement-breakpoint
CREATE FUNCTION app.enforce_sop_document_activation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  chunk_total integer;
  invalid_embedding_total integer;
BEGIN
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
CREATE TRIGGER sop_documents_enforce_activation BEFORE UPDATE ON app.sop_documents
FOR EACH ROW EXECUTE FUNCTION app.enforce_sop_document_activation();
--> statement-breakpoint
CREATE FUNCTION app.prevent_active_snapshot_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM app.sop_documents d
    WHERE d.id = OLD.document_id
      AND d.status = 'ACTIVE'
      AND d.active_job_id = OLD.job_id
  ) THEN
    RAISE EXCEPTION 'ACTIVE SOP snapshot chunks and extraction pages are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_chunks_immutable_active BEFORE UPDATE OR DELETE ON app.sop_chunks
FOR EACH ROW EXECUTE FUNCTION app.prevent_active_snapshot_mutation();
--> statement-breakpoint
CREATE TRIGGER sop_extraction_pages_immutable_active BEFORE UPDATE OR DELETE ON app.sop_extraction_pages
FOR EACH ROW EXECUTE FUNCTION app.prevent_active_snapshot_mutation();
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE app.sop_verification_records FROM sop_runtime;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_sop_verification_record(), app.enforce_sop_document_activation(), app.prevent_active_snapshot_mutation() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enforce_sop_verification_record(), app.enforce_sop_document_activation(), app.prevent_active_snapshot_mutation() TO sop_runtime;
--> statement-breakpoint
GRANT UPDATE (processed_attempt_id, active_job_id, active_pipeline_version, active_attempt_id, verified_by, verified_at, rejection_reason) ON app.sop_documents TO sop_runtime;
