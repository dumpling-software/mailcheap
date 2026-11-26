ALTER TABLE "automations" ADD COLUMN "topic" text DEFAULT 'automations' NOT NULL;--> statement-breakpoint
ALTER TABLE "campaigns" ADD COLUMN "topic" text DEFAULT 'product_updates' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "unsubscribed_topics" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "newsletters" ADD COLUMN "preferences_url" text;