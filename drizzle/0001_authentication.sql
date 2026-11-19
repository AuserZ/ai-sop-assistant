CREATE TABLE "app"."auth_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_invitations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_digest" text NOT NULL,
	"invited_by" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_invitations_token_digest_unique" UNIQUE("token_digest"),
	CONSTRAINT "auth_invitations_role" CHECK ("app"."auth_invitations"."role" in ('ADMIN', 'STAFF')),
	CONSTRAINT "auth_invitations_email_normalized" CHECK ("app"."auth_invitations"."email" = lower(btrim("app"."auth_invitations"."email")))
);
--> statement-breakpoint
CREATE TABLE "app"."auth_rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"attempts" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "app"."auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "app"."auth_users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"role" text DEFAULT 'STAFF' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "auth_users_email_unique" UNIQUE("email"),
	CONSTRAINT "auth_users_role" CHECK ("app"."auth_users"."role" in ('ADMIN', 'STAFF')),
	CONSTRAINT "auth_users_email_normalized" CHECK ("app"."auth_users"."email" = lower(btrim("app"."auth_users"."email")))
);
--> statement-breakpoint
CREATE TABLE "app"."auth_verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "app"."auth_accounts" ADD CONSTRAINT "auth_accounts_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_invitations" ADD CONSTRAINT "auth_invitations_invited_by_auth_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "app"."auth_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "app"."auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "app"."auth_users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "auth_accounts_provider_identity" ON "app"."auth_accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "auth_accounts_user_id" ON "app"."auth_accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_rate_limits_expiry" ON "app"."auth_rate_limits" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_id" ON "app"."auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "auth_verifications_identifier" ON "app"."auth_verifications" USING btree ("identifier");
--> statement-breakpoint
CREATE FUNCTION app.require_active_session_user() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE account_active boolean;
BEGIN
  -- Serialize session creation against role/status changes and their revocation.
  SELECT active INTO account_active FROM app.auth_users WHERE id = NEW.user_id FOR SHARE;
  IF account_active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Account is inactive' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_sessions_active_user BEFORE INSERT ON app.auth_sessions
FOR EACH ROW EXECUTE FUNCTION app.require_active_session_user();
--> statement-breakpoint
CREATE FUNCTION app.revoke_sessions_on_access_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM app.auth_sessions WHERE user_id = NEW.id;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER auth_users_revoke_sessions AFTER UPDATE OF active, role ON app.auth_users
FOR EACH ROW WHEN (OLD.active IS DISTINCT FROM NEW.active OR OLD.role IS DISTINCT FROM NEW.role)
EXECUTE FUNCTION app.revoke_sessions_on_access_change();
--> statement-breakpoint
REVOKE ALL ON FUNCTION app.require_active_session_user(), app.revoke_sessions_on_access_change() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app.require_active_session_user(), app.revoke_sessions_on_access_change() TO sop_runtime;
