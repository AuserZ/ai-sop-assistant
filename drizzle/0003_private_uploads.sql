CREATE TABLE "app"."document_upload_intents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"request_key" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"staging_key" text NOT NULL,
	"final_key" text NOT NULL,
	"reserved_bytes" bigint NOT NULL,
	"state" text DEFAULT 'AWAITING_UPLOAD' NOT NULL,
	"failure_code" text,
	"upload_expires_at" timestamp with time zone NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"finalize_lease_token" uuid,
	"finalize_lease_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "document_upload_intents_staging_key_unique" UNIQUE("staging_key"),
	CONSTRAINT "document_upload_intents_final_key_unique" UNIQUE("final_key"),
	CONSTRAINT "document_upload_state" CHECK ("app"."document_upload_intents"."state" in ('AWAITING_UPLOAD','FINALIZING','FAILED','ACCEPTED')),
	CONSTRAINT "document_upload_bytes" CHECK ("app"."document_upload_intents"."size_bytes" between 1 and 20000000 and "app"."document_upload_intents"."reserved_bytes" = 2::bigint * "app"."document_upload_intents"."size_bytes"),
	CONSTRAINT "document_upload_sha256" CHECK ("app"."document_upload_intents"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "document_upload_mime" CHECK ("app"."document_upload_intents"."mime_type" in ('application/pdf','application/vnd.openxmlformats-officedocument.wordprocessingml.document'))
);
--> statement-breakpoint
CREATE TABLE "app"."sop_documents" (
	"id" uuid PRIMARY KEY NOT NULL,
	"title" text NOT NULL,
	"file_name" text NOT NULL,
	"mime_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"original_key" text NOT NULL,
	"uploaded_by" text NOT NULL,
	"status" text DEFAULT 'UPLOADED' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sop_documents_original_key_unique" UNIQUE("original_key"),
	CONSTRAINT "sop_documents_status" CHECK ("app"."sop_documents"."status" = 'UPLOADED'),
	CONSTRAINT "sop_documents_sha256" CHECK ("app"."sop_documents"."sha256" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "sop_documents_bytes" CHECK ("app"."sop_documents"."size_bytes" between 1 and 20000000)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_scenario";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_kind";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_state";--> statement-breakpoint
DROP INDEX "app"."workflow_jobs_owner_request";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ALTER COLUMN "scenario" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ALTER COLUMN "attempt_deadline" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "document_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "source_sha256" text;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "pipeline_version" text;--> statement-breakpoint
ALTER TABLE "app"."document_upload_intents" ADD CONSTRAINT "document_upload_intents_owner_id_auth_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_id_document_upload_intents_id_fk" FOREIGN KEY ("id") REFERENCES "app"."document_upload_intents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."sop_documents" ADD CONSTRAINT "sop_documents_uploaded_by_auth_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "document_upload_owner_request" ON "app"."document_upload_intents" USING btree ("owner_id","request_key");--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_jobs_ingestion_identity" ON "app"."workflow_jobs" USING btree ("document_id","source_sha256","pipeline_version");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_jobs_owner_request" ON "app"."workflow_jobs" USING btree ("owner_id","kind","request_key");--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_kind_state" CHECK (("app"."workflow_jobs"."kind" = 'synthetic_probe' and "app"."workflow_jobs"."scenario" in ('success','validation_failure') and "app"."workflow_jobs"."scenario" is not null and "app"."workflow_jobs"."attempt_deadline" is not null and "app"."workflow_jobs"."state" <> 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."document_id" is null and "app"."workflow_jobs"."source_sha256" is null and "app"."workflow_jobs"."pipeline_version" is null) or ("app"."workflow_jobs"."kind" = 'document_ingestion' and "app"."workflow_jobs"."scenario" is null and "app"."workflow_jobs"."document_id" is not null and "app"."workflow_jobs"."source_sha256" ~ '^[a-f0-9]{64}$' and "app"."workflow_jobs"."source_sha256" is not null and "app"."workflow_jobs"."pipeline_version" is not null and "app"."workflow_jobs"."state" = 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."attempt_deadline" is null and "app"."workflow_jobs"."dispatch_count" = 0 and "app"."workflow_jobs"."dispatch_lease_token" is null and "app"."workflow_jobs"."dispatch_lease_until" is null and "app"."workflow_jobs"."dispatch_accepted_at" is null and "app"."workflow_jobs"."run_lease_until" is null and "app"."workflow_jobs"."execution_id" is null and "app"."workflow_jobs"."step" = 0 and "app"."workflow_jobs"."attempt_number" = 1));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_kind" CHECK ("app"."workflow_jobs"."kind" in ('synthetic_probe','document_ingestion'));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_state" CHECK ("app"."workflow_jobs"."state" in ('QUEUED','RUNNING','COMPLETED','FAILED','WAITING_FOR_PIPELINE'));
--> statement-breakpoint
CREATE FUNCTION app.keep_upload_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(OLD.id, OLD.owner_id, OLD.request_key, OLD.input_hash, OLD.title, OLD.file_name, OLD.mime_type,
    OLD.size_bytes, OLD.sha256, OLD.staging_key, OLD.final_key, OLD.reserved_bytes, OLD.upload_expires_at, OLD.expires_at)
    IS DISTINCT FROM ROW(NEW.id, NEW.owner_id, NEW.request_key, NEW.input_hash, NEW.title, NEW.file_name, NEW.mime_type,
    NEW.size_bytes, NEW.sha256, NEW.staging_key, NEW.final_key, NEW.reserved_bytes, NEW.upload_expires_at, NEW.expires_at)
    OR (OLD.state = 'ACCEPTED' AND NEW.state <> 'ACCEPTED') THEN
    RAISE EXCEPTION 'Upload identity and reservation are immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER document_upload_immutable_identity BEFORE UPDATE ON app.document_upload_intents
FOR EACH ROW EXECUTE FUNCTION app.keep_upload_identity();
--> statement-breakpoint
CREATE FUNCTION app.bind_document_original() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM app.document_upload_intents u WHERE u.id = NEW.id AND u.owner_id = NEW.uploaded_by
    AND u.title = NEW.title AND u.file_name = NEW.file_name AND u.mime_type = NEW.mime_type
    AND u.size_bytes = NEW.size_bytes AND u.sha256 = NEW.sha256 AND u.final_key = NEW.original_key) THEN
    RAISE EXCEPTION 'Document original must match upload identity' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER sop_document_bound_original BEFORE INSERT OR UPDATE ON app.sop_documents
FOR EACH ROW EXECUTE FUNCTION app.bind_document_original();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.keep_workflow_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND (OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.request_key IS DISTINCT FROM NEW.request_key
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.scenario IS DISTINCT FROM NEW.scenario OR OLD.document_id IS DISTINCT FROM NEW.document_id
    OR OLD.source_sha256 IS DISTINCT FROM NEW.source_sha256 OR OLD.pipeline_version IS DISTINCT FROM NEW.pipeline_version) THEN
    RAISE EXCEPTION 'Workflow identity is immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW.kind = 'document_ingestion' AND NOT EXISTS (SELECT 1 FROM app.sop_documents d
    WHERE d.id = NEW.document_id AND d.sha256 = NEW.source_sha256 AND d.uploaded_by = NEW.owner_id) THEN
    RAISE EXCEPTION 'Ingestion must match immutable document source' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
DROP TRIGGER workflow_jobs_immutable_identity ON app.workflow_jobs;
--> statement-breakpoint
CREATE TRIGGER workflow_jobs_immutable_identity BEFORE INSERT OR UPDATE ON app.workflow_jobs
FOR EACH ROW EXECUTE FUNCTION app.keep_workflow_job_identity();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.keep_upload_identity(), app.bind_document_original() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.keep_upload_identity(), app.bind_document_original() TO sop_runtime;
--> statement-breakpoint
REVOKE DELETE ON app.document_upload_intents FROM sop_runtime;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON app.sop_documents FROM sop_runtime;
