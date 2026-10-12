CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" text NOT NULL,
	"title" text,
	"last_sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "api_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"prefix" text NOT NULL,
	"hash" text NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newsletter_id" uuid NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"preview_text" text DEFAULT '' NOT NULL,
	"format" text DEFAULT 'rich' NOT NULL,
	"markdown" text DEFAULT '' NOT NULL,
	"html" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"audience_limit" integer,
	"source" text DEFAULT 'dashboard' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"started_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"test_sent_at" timestamp with time zone,
	"archive_slug" text,
	"thumbnail_url" text,
	"archive_listed" boolean DEFAULT true NOT NULL,
	"archive_pinned" boolean DEFAULT false NOT NULL,
	"web_views" integer DEFAULT 0 NOT NULL,
	"stats" jsonb DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"opened":0,"clicked":0,"unsubscribed":0,"failed":0}'::jsonb NOT NULL,
	"last_chance" jsonb DEFAULT '{"recipients":0,"sent":0,"delivered":0,"bounced":0,"complained":0,"failed":0,"dormant":0}'::jsonb NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newsletter_id" uuid NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"source" text,
	"subscribed_at" timestamp with time zone DEFAULT now(),
	"confirmed_at" timestamp with time zone,
	"unsubscribed_at" timestamp with time zone,
	"last_sent_at" timestamp with time zone,
	"last_open_at" timestamp with time zone,
	"last_click_at" timestamp with time zone,
	"ignored_issues" integer,
	"last_engaged_at" timestamp with time zone,
	"last_chance_at" timestamp with time zone,
	"stats" jsonb DEFAULT '{"sent":0,"opens":0,"clicks":0}'::jsonb NOT NULL,
	"imported" jsonb,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"ses_message_id" text,
	"message_id" uuid,
	"campaign_id" uuid,
	"email" text,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"data" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"seq" bigint GENERATED ALWAYS AS IDENTITY (sequence name "messages_seq_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"kind" text NOT NULL,
	"campaign_id" uuid,
	"newsletter_id" uuid NOT NULL,
	"contact_id" uuid,
	"email" text NOT NULL,
	"provider" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"ses_message_id" text,
	"error" text,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "newsletters" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"image_url" text,
	"from_name" text,
	"from_email" text NOT NULL,
	"reply_to" text,
	"postal_address" text,
	"archive_enabled" boolean DEFAULT false NOT NULL,
	"description" text,
	"social_links" text[] DEFAULT '{}'::text[] NOT NULL,
	"author" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"require_confirmation" boolean DEFAULT false NOT NULL,
	"cleanup" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"welcome" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"confirmation" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"external_source" text,
	"external_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"reason" text NOT NULL,
	"detail" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_key_key" ON "alerts" USING btree ("key");--> statement-breakpoint
CREATE UNIQUE INDEX "api_keys_hash_key" ON "api_keys" USING btree ("hash");--> statement-breakpoint
CREATE INDEX "campaigns_newsletter_created_idx" ON "campaigns" USING btree ("newsletter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "campaigns_status_idx" ON "campaigns" USING btree ("status");--> statement-breakpoint
CREATE INDEX "campaigns_started_idx" ON "campaigns" USING btree ("started_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_archive_slug_key" ON "campaigns" USING btree ("archive_slug") WHERE "campaigns"."archive_slug" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_external_key" ON "campaigns" USING btree ("external_source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_newsletter_email_key" ON "contacts" USING btree ("newsletter_id","email");--> statement-breakpoint
CREATE INDEX "contacts_email_idx" ON "contacts" USING btree ("email" text_pattern_ops);--> statement-breakpoint
CREATE INDEX "contacts_newsletter_status_idx" ON "contacts" USING btree ("newsletter_id","status","subscribed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_status_idx" ON "contacts" USING btree ("status","subscribed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_subscribed_idx" ON "contacts" USING btree ("subscribed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_newsletter_subscribed_idx" ON "contacts" USING btree ("newsletter_id","subscribed_at" DESC NULLS LAST,"id" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "contacts_last_chance_idx" ON "contacts" USING btree ("newsletter_id","last_chance_at") WHERE "contacts"."last_chance_at" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "contacts_external_key" ON "contacts" USING btree ("newsletter_id","external_source","external_id");--> statement-breakpoint
CREATE INDEX "events_campaign_type_idx" ON "events" USING btree ("campaign_id","type");--> statement-breakpoint
CREATE INDEX "events_ses_message_idx" ON "events" USING btree ("ses_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_campaign_contact_key" ON "messages" USING btree ("campaign_id","contact_id") WHERE "messages"."kind" = 'campaign';--> statement-breakpoint
CREATE UNIQUE INDEX "messages_last_chance_key" ON "messages" USING btree ("campaign_id","contact_id") WHERE "messages"."kind" = 'last-chance';--> statement-breakpoint
CREATE INDEX "messages_ses_message_idx" ON "messages" USING btree ("ses_message_id") WHERE "messages"."ses_message_id" is not null;--> statement-breakpoint
CREATE INDEX "messages_kind_created_idx" ON "messages" USING btree ("kind","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "messages_newsletter_sent_idx" ON "messages" USING btree ("newsletter_id","sent_at");--> statement-breakpoint
CREATE INDEX "messages_campaign_status_idx" ON "messages" USING btree ("campaign_id","status","kind","seq");--> statement-breakpoint
CREATE INDEX "messages_contact_idx" ON "messages" USING btree ("contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletters_slug_key" ON "newsletters" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "newsletters_external_key" ON "newsletters" USING btree ("external_source","external_id");--> statement-breakpoint
CREATE UNIQUE INDEX "suppressions_email_key" ON "suppressions" USING btree ("email");