CREATE TABLE "contact_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"newsletter_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"name" text NOT NULL,
	"properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "api_keys" ADD COLUMN "newsletter_id" uuid;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "properties" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "contact_events" ADD CONSTRAINT "contact_events_contact_id_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."contacts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_events_contact_name_idx" ON "contact_events" USING btree ("contact_id","name","occurred_at" DESC NULLS LAST);--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_newsletter_id_newsletters_id_fk" FOREIGN KEY ("newsletter_id") REFERENCES "public"."newsletters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contacts_properties_idx" ON "contacts" USING gin ("properties");--> statement-breakpoint
ALTER TABLE contact_events ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER contact_events_updated_at BEFORE UPDATE ON contact_events FOR EACH ROW EXECUTE FUNCTION set_updated_at();
