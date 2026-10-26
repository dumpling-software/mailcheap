CREATE TABLE "email_domain_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"domain" text NOT NULL,
	"verdict" text NOT NULL,
	"source" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"action" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "email_domain_checks_domain_key" ON "email_domain_checks" USING btree ("domain");--> statement-breakpoint
CREATE UNIQUE INDEX "email_rules_kind_value_key" ON "email_rules" USING btree ("kind","value");--> statement-breakpoint
ALTER TABLE email_rules ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE email_domain_checks ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
CREATE TRIGGER email_rules_updated_at BEFORE UPDATE ON email_rules FOR EACH ROW EXECUTE FUNCTION set_updated_at();--> statement-breakpoint
CREATE TRIGGER email_domain_checks_updated_at BEFORE UPDATE ON email_domain_checks FOR EACH ROW EXECUTE FUNCTION set_updated_at();
