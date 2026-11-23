CREATE TABLE "app"."chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_title_nonempty" CHECK (length(btrim("app"."chat_conversations"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "app"."chat_message_sources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"chunk_id" uuid NOT NULL,
	"sop_title" text NOT NULL,
	"section_path" text NOT NULL,
	"page_start" integer,
	"page_end" integer,
	"citation_order" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_message_sources_order" CHECK ("app"."chat_message_sources"."citation_order" >= 0),
	CONSTRAINT "chat_message_sources_pages" CHECK (("app"."chat_message_sources"."page_start" is null or "app"."chat_message_sources"."page_start" >= 1) and ("app"."chat_message_sources"."page_end" is null or ("app"."chat_message_sources"."page_start" is not null and "app"."chat_message_sources"."page_end" >= "app"."chat_message_sources"."page_start")))
);
--> statement-breakpoint
CREATE TABLE "app"."chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"owner_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"request_key" uuid NOT NULL,
	"job_id" uuid,
	"validation_status" text NOT NULL,
	"is_procedural" boolean DEFAULT false NOT NULL,
	"timings" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role" CHECK ("app"."chat_messages"."role" in ('user','assistant')),
	CONSTRAINT "chat_messages_content_nonempty" CHECK (length(btrim("app"."chat_messages"."content")) > 0),
	CONSTRAINT "chat_messages_validation_status" CHECK (("app"."chat_messages"."role" = 'user' and "app"."chat_messages"."validation_status" = 'USER_INPUT' and "app"."chat_messages"."is_procedural" = false) or ("app"."chat_messages"."role" = 'assistant' and "app"."chat_messages"."validation_status" in ('PASSED','NO_EVIDENCE'))),
	CONSTRAINT "chat_messages_no_evidence_exact" CHECK ("app"."chat_messages"."validation_status" <> 'NO_EVIDENCE' or ("app"."chat_messages"."content" = 'No SOP found for this question' and "app"."chat_messages"."is_procedural" = false))
);
--> statement-breakpoint
CREATE TABLE "app"."chat_turn_artifacts" (
	"job_id" uuid PRIMARY KEY NOT NULL,
	"attempt_id" uuid NOT NULL,
	"question_text" text NOT NULL,
	"retrieval_payload" jsonb,
	"candidate_payload" jsonb,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_turn_artifacts_question_nonempty" CHECK (length(btrim("app"."chat_turn_artifacts"."question_text")) > 0)
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_events" DROP CONSTRAINT "workflow_events_kind";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_kind";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_kind_state";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" DROP CONSTRAINT "workflow_jobs_attempt_bounds";--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "conversation_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "assistant_message_id" uuid;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD COLUMN "error_retryable" boolean;--> statement-breakpoint
ALTER TABLE "app"."chat_conversations" ADD CONSTRAINT "chat_conversations_owner_id_auth_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_message_sources" ADD CONSTRAINT "chat_message_sources_message_id_chat_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "app"."chat_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_message_sources" ADD CONSTRAINT "chat_message_sources_document_id_sop_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "app"."sop_documents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_messages" ADD CONSTRAINT "chat_messages_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_messages" ADD CONSTRAINT "chat_messages_owner_id_auth_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_messages" ADD CONSTRAINT "chat_messages_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."chat_turn_artifacts" ADD CONSTRAINT "chat_turn_artifacts_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_updated" ON "app"."chat_conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "chat_message_sources_message_chunk" ON "app"."chat_message_sources" USING btree ("message_id","chunk_id");--> statement-breakpoint
CREATE INDEX "chat_message_sources_message_order" ON "app"."chat_message_sources" USING btree ("message_id","citation_order");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_owner_request_role" ON "app"."chat_messages" USING btree ("owner_id","request_key","role");--> statement-breakpoint
CREATE INDEX "chat_messages_conversation_created" ON "app"."chat_messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_conversation_id_chat_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "app"."chat_conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_assistant_message_id_chat_messages_id_fk" FOREIGN KEY ("assistant_message_id") REFERENCES "app"."chat_messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_events" ADD CONSTRAINT "workflow_events_kind" CHECK ("app"."workflow_events"."kind" in ('accepted','started','processing','deterministic_pass','judge_stub_pass','synthetic_completed','failed','retrying','retrieving','reranking','generating','validating','completed','no_evidence'));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_kind" CHECK ("app"."workflow_jobs"."kind" in ('synthetic_probe','document_ingestion','chat_turn'));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_kind_state" CHECK (("app"."workflow_jobs"."kind" = 'synthetic_probe' and "app"."workflow_jobs"."scenario" in ('success','validation_failure') and "app"."workflow_jobs"."scenario" is not null and "app"."workflow_jobs"."attempt_deadline" is not null and "app"."workflow_jobs"."state" <> 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."document_id" is null and "app"."workflow_jobs"."source_sha256" is null and "app"."workflow_jobs"."pipeline_version" is null and "app"."workflow_jobs"."conversation_id" is null and "app"."workflow_jobs"."assistant_message_id" is null) or ("app"."workflow_jobs"."kind" = 'document_ingestion' and "app"."workflow_jobs"."scenario" is null and "app"."workflow_jobs"."document_id" is not null and "app"."workflow_jobs"."source_sha256" ~ '^[a-f0-9]{64}$' and "app"."workflow_jobs"."source_sha256" is not null and "app"."workflow_jobs"."pipeline_version" is not null and "app"."workflow_jobs"."conversation_id" is null and "app"."workflow_jobs"."assistant_message_id" is null and (("app"."workflow_jobs"."state" = 'WAITING_FOR_PIPELINE' and "app"."workflow_jobs"."attempt_deadline" is null and "app"."workflow_jobs"."dispatch_count" = 0 and "app"."workflow_jobs"."dispatch_lease_token" is null and "app"."workflow_jobs"."dispatch_lease_until" is null and "app"."workflow_jobs"."dispatch_accepted_at" is null and "app"."workflow_jobs"."run_lease_until" is null and "app"."workflow_jobs"."execution_id" is null and "app"."workflow_jobs"."step" = 0 and "app"."workflow_jobs"."attempt_number" = 1) or ("app"."workflow_jobs"."state" in ('QUEUED','RUNNING','COMPLETED','FAILED') and "app"."workflow_jobs"."attempt_deadline" is not null))) or ("app"."workflow_jobs"."kind" = 'chat_turn' and "app"."workflow_jobs"."scenario" is null and "app"."workflow_jobs"."document_id" is null and "app"."workflow_jobs"."source_sha256" is null and "app"."workflow_jobs"."pipeline_version" is null and "app"."workflow_jobs"."conversation_id" is not null and "app"."workflow_jobs"."attempt_deadline" is not null and "app"."workflow_jobs"."state" in ('QUEUED','RUNNING','COMPLETED','FAILED')));--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_attempt_bounds" CHECK ("app"."workflow_jobs"."attempt_number" between 1 and 3 and "app"."workflow_jobs"."dispatch_count" between 0 and 3 and "app"."workflow_jobs"."step" between 0 and 8);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.keep_workflow_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.request_key IS DISTINCT FROM NEW.request_key
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.scenario IS DISTINCT FROM NEW.scenario OR OLD.conversation_id IS DISTINCT FROM NEW.conversation_id THEN
    RAISE EXCEPTION 'Workflow identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE FUNCTION app.enforce_chat_message_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.chat_conversations c
    WHERE c.id = NEW.conversation_id
      AND c.owner_id = NEW.owner_id
  ) THEN
    RAISE EXCEPTION 'Chat message owner must match conversation owner' USING ERRCODE = '23514';
  END IF;

  IF NEW.job_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM app.workflow_jobs j
    WHERE j.id = NEW.job_id
      AND j.kind = 'chat_turn'
      AND j.owner_id = NEW.owner_id
      AND j.conversation_id = NEW.conversation_id
  ) THEN
    RAISE EXCEPTION 'Chat message job must match chat_turn owner and conversation' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_messages_enforce_owner BEFORE INSERT OR UPDATE ON app.chat_messages
FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_message_owner();
--> statement-breakpoint
CREATE FUNCTION app.enforce_chat_message_source_passed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.chat_messages m
    WHERE m.id = NEW.message_id
      AND m.role = 'assistant'
      AND m.validation_status = 'PASSED'
  ) THEN
    RAISE EXCEPTION 'Chat message sources require a PASSED assistant message' USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_message_sources_enforce_passed BEFORE INSERT OR UPDATE ON app.chat_message_sources
FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_message_source_passed();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.enforce_chat_message_owner(), app.enforce_chat_message_source_passed() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enforce_chat_message_owner(), app.enforce_chat_message_source_passed() TO sop_runtime;
--> statement-breakpoint
REVOKE ALL ON TABLE app.chat_conversations, app.chat_messages, app.chat_message_sources, app.chat_turn_artifacts FROM PUBLIC;
--> statement-breakpoint
REVOKE UPDATE ON TABLE app.chat_conversations FROM sop_runtime;
--> statement-breakpoint
GRANT UPDATE (title, updated_at) ON TABLE app.chat_conversations TO sop_runtime;
--> statement-breakpoint
REVOKE UPDATE ON TABLE app.chat_messages FROM sop_runtime;
--> statement-breakpoint
REVOKE UPDATE ON TABLE app.chat_message_sources FROM sop_runtime;
