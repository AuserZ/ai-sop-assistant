ALTER TABLE "app"."chat_conversations" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "chat_conversations_owner_active_updated" ON "app"."chat_conversations" USING btree ("owner_id","updated_at" DESC NULLS LAST,"id" DESC NULLS LAST) WHERE "app"."chat_conversations"."archived_at" is null;

--> statement-breakpoint
CREATE FUNCTION app.enforce_chat_conversation_archive() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.archived_at IS NOT NULL AND (
    NEW.archived_at IS DISTINCT FROM OLD.archived_at
    OR NEW.title IS DISTINCT FROM OLD.title
  ) THEN
    RAISE EXCEPTION 'Archived chat conversations cannot be modified or restored' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER chat_conversations_enforce_archive BEFORE UPDATE ON app.chat_conversations
FOR EACH ROW EXECUTE FUNCTION app.enforce_chat_conversation_archive();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app.enforce_chat_message_owner() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM app.chat_conversations c
    WHERE c.id = NEW.conversation_id
      AND c.owner_id = NEW.owner_id
      AND (NEW.role <> 'user' OR c.archived_at IS NULL)
  ) THEN
    RAISE EXCEPTION 'Chat message owner must match active conversation owner' USING ERRCODE = '23514';
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
REVOKE ALL ON FUNCTION app.enforce_chat_conversation_archive() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.enforce_chat_conversation_archive() TO sop_runtime;
--> statement-breakpoint
GRANT UPDATE (archived_at) ON TABLE app.chat_conversations TO sop_runtime;
