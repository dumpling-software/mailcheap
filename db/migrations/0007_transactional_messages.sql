CREATE TABLE "transactional_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ses_message_id" text NOT NULL,
	"domain" text,
	"from_address" text,
	"email" text,
	"subject" text,
	"provider" text,
	"status" text DEFAULT 'sent' NOT NULL,
	"error" text,
	"sent_at" timestamp with time zone NOT NULL,
	"delivered_at" timestamp with time zone,
	"delayed_at" timestamp with time zone,
	"bounced_at" timestamp with time zone,
	"complained_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "transactional_messages_ses_message_key" ON "transactional_messages" USING btree ("ses_message_id");--> statement-breakpoint
CREATE INDEX "transactional_messages_sent_idx" ON "transactional_messages" USING btree ("sent_at");--> statement-breakpoint
CREATE INDEX "transactional_messages_domain_sent_idx" ON "transactional_messages" USING btree ("domain","sent_at");--> statement-breakpoint
ALTER TABLE transactional_messages ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER transactional_messages_updated_at BEFORE UPDATE ON transactional_messages FOR EACH ROW EXECUTE FUNCTION set_updated_at();
