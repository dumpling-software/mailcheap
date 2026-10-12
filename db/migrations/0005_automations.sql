CREATE TABLE "automations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newsletter_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"trigger" jsonb DEFAULT '{"type":"contact_added"}'::jsonb NOT NULL,
	"exit_when" jsonb,
	"start_node_id" text DEFAULT 'start' NOT NULL,
	"nodes" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"allow_reentry" boolean DEFAULT false NOT NULL,
	"paused_reason" text,
	"stats" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "enrollments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"automation_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"current_node_id" text,
	"next_run_at" timestamp with time zone,
	"wait_for" jsonb,
	"trigger_event" jsonb,
	"locked_until" timestamp with time zone,
	"history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exit_reason" text,
	"enrolled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "automation_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "enrollment_id" uuid;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "node_id" text;--> statement-breakpoint
ALTER TABLE "automations" ADD CONSTRAINT "automations_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "enrollments" ADD CONSTRAINT "enrollments_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "automations_newsletter_status_idx" ON "automations" USING btree ("newsletter_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "automations_external_key" ON "automations" USING btree ("external_source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "enrollments_live_key" ON "enrollments" USING btree ("automation_id","contact_id") WHERE "enrollments"."status" in ('active', 'waiting');--> statement-breakpoint
CREATE INDEX "enrollments_due_idx" ON "enrollments" USING btree ("next_run_at") WHERE "enrollments"."status" in ('active', 'waiting');--> statement-breakpoint
CREATE INDEX "enrollments_contact_idx" ON "enrollments" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX "enrollments_automation_status_idx" ON "enrollments" USING btree ("automation_id","status");--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_automation_id_automations_id_fk" FOREIGN KEY ("automation_id") REFERENCES "public"."automations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_enrollment_id_enrollments_id_fk" FOREIGN KEY ("enrollment_id") REFERENCES "public"."enrollments"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "messages_enrollment_node_key" ON "messages" USING btree ("enrollment_id","node_id") WHERE "messages"."kind" = 'automation';--> statement-breakpoint
CREATE INDEX "messages_automation_node_idx" ON "messages" USING btree ("automation_id","node_id") WHERE "messages"."automation_id" is not null;--> statement-breakpoint
ALTER TABLE automations ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE enrollments ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER automations_updated_at BEFORE UPDATE ON automations FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER enrollments_updated_at BEFORE UPDATE ON enrollments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
