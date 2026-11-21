CREATE TABLE "app"."workflow_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"sequence" integer NOT NULL,
	"step" integer NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_events_kind" CHECK ("app"."workflow_events"."kind" in ('accepted','started','processing','deterministic_pass','judge_stub_pass','synthetic_completed','failed','retrying'))
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"request_key" uuid NOT NULL,
	"input_hash" text NOT NULL,
	"kind" text DEFAULT 'synthetic_probe' NOT NULL,
	"scenario" text NOT NULL,
	"state" text DEFAULT 'QUEUED' NOT NULL,
	"attempt_id" uuid NOT NULL,
	"attempt_number" integer DEFAULT 1 NOT NULL,
	"dispatch_nonce" uuid NOT NULL,
	"dispatch_count" integer DEFAULT 0 NOT NULL,
	"dispatch_next_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatch_lease_token" uuid,
	"dispatch_lease_until" timestamp with time zone,
	"dispatch_accepted_at" timestamp with time zone,
	"attempt_deadline" timestamp with time zone NOT NULL,
	"run_lease_until" timestamp with time zone,
	"execution_id" text,
	"step" integer DEFAULT 0 NOT NULL,
	"event_sequence" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "workflow_jobs_kind" CHECK ("app"."workflow_jobs"."kind" = 'synthetic_probe'),
	CONSTRAINT "workflow_jobs_state" CHECK ("app"."workflow_jobs"."state" in ('QUEUED','RUNNING','COMPLETED','FAILED')),
	CONSTRAINT "workflow_jobs_scenario" CHECK ("app"."workflow_jobs"."scenario" in ('success','validation_failure')),
	CONSTRAINT "workflow_jobs_attempt_bounds" CHECK ("app"."workflow_jobs"."attempt_number" between 1 and 3 and "app"."workflow_jobs"."dispatch_count" between 0 and 3 and "app"."workflow_jobs"."step" between 0 and 5)
);
--> statement-breakpoint
CREATE TABLE "app"."workflow_nonce_receipts" (
	"id" text PRIMARY KEY NOT NULL,
	"job_id" uuid NOT NULL,
	"attempt_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."workflow_events" ADD CONSTRAINT "workflow_events_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_jobs" ADD CONSTRAINT "workflow_jobs_owner_id_auth_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."workflow_nonce_receipts" ADD CONSTRAINT "workflow_nonce_receipts_job_id_workflow_jobs_id_fk" FOREIGN KEY ("job_id") REFERENCES "app"."workflow_jobs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_events_sequence" ON "app"."workflow_events" USING btree ("job_id","sequence");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_events_attempt_step" ON "app"."workflow_events" USING btree ("job_id","attempt_id","step");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_jobs_owner_request" ON "app"."workflow_jobs" USING btree ("owner_id","request_key");--> statement-breakpoint
CREATE INDEX "workflow_jobs_dispatch_due" ON "app"."workflow_jobs" USING btree ("state","dispatch_next_at");--> statement-breakpoint
CREATE INDEX "workflow_nonce_expiry" ON "app"."workflow_nonce_receipts" USING btree ("expires_at");
--> statement-breakpoint
CREATE FUNCTION app.keep_workflow_job_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.owner_id IS DISTINCT FROM NEW.owner_id OR OLD.request_key IS DISTINCT FROM NEW.request_key
    OR OLD.input_hash IS DISTINCT FROM NEW.input_hash OR OLD.kind IS DISTINCT FROM NEW.kind
    OR OLD.scenario IS DISTINCT FROM NEW.scenario THEN
    RAISE EXCEPTION 'Workflow identity is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER workflow_jobs_immutable_identity BEFORE UPDATE ON app.workflow_jobs
FOR EACH ROW EXECUTE FUNCTION app.keep_workflow_job_identity();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.keep_workflow_job_identity() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.keep_workflow_job_identity() TO sop_runtime;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON TABLE app.workflow_events FROM sop_runtime;
--> statement-breakpoint
REVOKE UPDATE ON TABLE app.workflow_nonce_receipts FROM sop_runtime;
