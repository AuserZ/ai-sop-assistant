CREATE TABLE "app"."sop_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_sha256" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"sequence" integer NOT NULL,
	"section_path" text NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"content_type" text NOT NULL,
	"text" text NOT NULL,
	"content_hash" text NOT NULL,
	"token_estimate" integer NOT NULL,
	"search_vector" tsvector GENERATED ALWAYS AS (to_tsvector('simple', coalesce(section_path, '') || ' ' || text)) STORED NOT NULL,
	"embedding" public.vector(1536),
	"embedding_model" text,
	"embedding_dimensions" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_chunks_sha256" CHECK ("app"."sop_chunks"."source_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sop_chunks_sequence" CHECK ("app"."sop_chunks"."sequence" >= 0),
	CONSTRAINT "sop_chunks_pages" CHECK (("app"."sop_chunks"."page_start" is null or "app"."sop_chunks"."page_start" >= 1) and ("app"."sop_chunks"."page_end" is null or ("app"."sop_chunks"."page_start" is not null and "app"."sop_chunks"."page_end" >= "app"."sop_chunks"."page_start"))),
	CONSTRAINT "sop_chunks_content_type" CHECK ("app"."sop_chunks"."content_type" in ('procedure','table','narrative','mixed')),
	CONSTRAINT "sop_chunks_text_nonempty" CHECK (length(btrim("app"."sop_chunks"."text")) > 0),
	CONSTRAINT "sop_chunks_content_hash" CHECK ("app"."sop_chunks"."content_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sop_chunks_token_estimate" CHECK ("app"."sop_chunks"."token_estimate" > 0),
	CONSTRAINT "sop_chunks_embedding_dimensions" CHECK ("app"."sop_chunks"."embedding_dimensions" is null or "app"."sop_chunks"."embedding_dimensions" = 1536)
);
--> statement-breakpoint
CREATE TABLE "app"."sop_extraction_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"source_sha256" text NOT NULL,
	"pipeline_version" text NOT NULL,
	"page_index" integer NOT NULL,
	"page_kind" text NOT NULL,
	"source_location_kind" text NOT NULL,
	"raw_text" text NOT NULL,
	"normalized_text" text NOT NULL,
	"ocr_confidence" real,
	"ocr_model" text,
	"layout_metadata" jsonb,
	"verification_status" text DEFAULT 'UNVERIFIED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_extraction_pages_sha256" CHECK ("app"."sop_extraction_pages"."source_sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sop_extraction_pages_index" CHECK ("app"."sop_extraction_pages"."page_index" >= 1),
	CONSTRAINT "sop_extraction_pages_kind" CHECK ("app"."sop_extraction_pages"."page_kind" in ('native','scanned_ocr','mixed_ocr','blank','docx_section_flow')),
	CONSTRAINT "sop_extraction_pages_location" CHECK ("app"."sop_extraction_pages"."source_location_kind" in ('pdf_page','docx_derivative_preview')),
	CONSTRAINT "sop_extraction_pages_confidence" CHECK ("app"."sop_extraction_pages"."ocr_confidence" is null or ("app"."sop_extraction_pages"."ocr_confidence" >= 0 and "app"."sop_extraction_pages"."ocr_confidence" <= 1)),
	CONSTRAINT "sop_extraction_pages_unverified" CHECK ("app"."sop_extraction_pages"."verification_status" = 'UNVERIFIED')
);
--> statement-breakpoint
CREATE TABLE "app"."sop_verification_issues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"job_id" uuid NOT NULL,
	"page_index" integer,
	"section_path" text,
	"severity" text NOT NULL,
	"issue_code" text NOT NULL,
	"summary" text NOT NULL,
	"region" jsonb,
	"resolved_at" timestamp with time zone,
	"resolved_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_verification_issues_severity" CHECK ("app"."sop_verification_issues"."severity" in ('info','warning','error'))
);
--> statement-breakpoint
ALTER TABLE "app"."sop_documents" DROP CONSTRAINT "sop_documents_status";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_kind_state";--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "preview_key" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "latest_job_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "processed_job_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "processed_pipeline_version" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "processing_error_code" text;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "stage" text;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "error_code" text;--> statement-breakpoint
ALTER TABLE "app"."sop_chunks" ADD CONSTRAINT "sop_chunks_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_chunks" ADD CONSTRAINT "sop_chunks_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_extraction_pages" ADD CONSTRAINT "sop_extraction_pages_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_extraction_pages" ADD CONSTRAINT "sop_extraction_pages_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_issues" ADD CONSTRAINT "sop_verification_issues_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_issues" ADD CONSTRAINT "sop_verification_issues_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_verification_issues" ADD CONSTRAINT "sop_verification_issues_resolved_by_auth_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "sop_chunks_job_sequence" ON "app"."sop_chunks" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE INDEX "sop_chunks_search_vector" ON "app"."sop_chunks" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "sop_chunks_document_job" ON "app"."sop_chunks" USING btree ("document_id","job_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sop_extraction_pages_job_page" ON "app"."sop_extraction_pages" USING btree ("job_id","page_index");--> statement-breakpoint
CREATE INDEX "sop_extraction_pages_document_job" ON "app"."sop_extraction_pages" USING btree ("document_id","job_id");--> statement-breakpoint
CREATE INDEX "sop_verification_issues_document_job" ON "app"."sop_verification_issues" USING btree ("document_id","job_id");--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_latest_job_id_workflow_jobs_id_fk" FOREIGN KEY ("latest_job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_processed_job_id_workflow_jobs_id_fk" FOREIGN KEY ("processed_job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_preview_key_unique" UNIQUE("preview_key");--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_status" CHECK ("app"."sop_documents"."status" in ('UPLOADED','PROCESSING','PENDING_VERIFICATION','FAILED'));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_kind_state" CHECK (("app"."workflow_jobs"."kind" = 'synthetic_probe' and "app"."workflow_jobs"."scenario" in ('success','validation_failure') and "app"."workflow_jobs"."scenario" is not null and "app"."workflow_jobs"."attempt_deadline" is not null and "app"."workflow_jobs"."state" <> 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."document_id" is null and "app"."workflow_jobs"."source_sha256" is null and "app"."workflow_jobs"."pipeline_version" is null) or ("app"."workflow_jobs"."kind" = 'document_ingestion' and "app"."workflow_jobs"."scenario" is null and "app"."workflow_jobs"."document_id" is not null and "app"."workflow_jobs"."source_sha256" ~ '^[a-f0-9]{64}$' and "app"."workflow_jobs"."source_sha256" is not null and "app"."workflow_jobs"."pipeline_version" is not null and (("app"."workflow_jobs"."state" = 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."attempt_deadline" is null and "app"."workflow_jobs"."dispatch_count" = 0 and "app"."workflow_jobs"."dispatch_lease_token" is null and "app"."workflow_jobs"."dispatch_lease_until" is null and "app"."workflow_jobs"."dispatch_accepted_at" is null and "app"."workflow_jobs"."run_lease_until" is null and "app"."workflow_jobs"."execution_id" is null and "app"."workflow_jobs"."step" = 0 and "app"."workflow_jobs"."attempt_number" = 1) or ("app"."workflow_jobs"."state" in ('QUEUED','RUNNING','COMPLETED','FAILED') and "app"."workflow_jobs"."attempt_deadline" is not null))));
--> statement-breakpoint
CREATE FUNCTION app.bind_ingestion_artifact_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.workflow_jobs j
    WHERE j.id = NEW.job_id
      AND j.kind = 'document_ingestion'
      AND j.document_id = NEW.document_id
      AND j.source_sha256 = NEW.source_sha256
      AND j.pipeline_version = NEW.pipeline_version
  ) THEN
    RAISE EXCEPTION 'Ingestion artifact must match document_ingestion job identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_extraction_pages_bound_identity BEFORE INSERT OR UPDATE ON app.sop_extraction_pages
FOR EACH ROW EXECUTE FUNCTION app.bind_ingestion_artifact_identity();
--> statement-breakpoint
CREATE TRIGGER sop_chunks_bound_identity BEFORE INSERT OR UPDATE ON app.sop_chunks
FOR EACH ROW EXECUTE FUNCTION app.bind_ingestion_artifact_identity();
--> statement-breakpoint
CREATE FUNCTION app.bind_verification_issue_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.workflow_jobs j
    WHERE j.id = NEW.job_id
      AND j.kind = 'document_ingestion'
      AND j.document_id = NEW.document_id
  ) THEN
    RAISE EXCEPTION 'Verification issue must match document_ingestion job identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_verification_issues_bound_identity BEFORE INSERT OR UPDATE ON app.sop_verification_issues
FOR EACH ROW EXECUTE FUNCTION app.bind_verification_issue_identity();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.bind_ingestion_artifact_identity(), app.bind_verification_issue_identity() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.bind_ingestion_artifact_identity(), app.bind_verification_issue_identity() TO sop_runtime;
--> statement-breakpoint
GRANT UPDATE (status, preview_key, latest_job_id, processed_job_id, processed_pipeline_version, processing_error_code, updated_at) ON app.sop_documents TO sop_runtime;
