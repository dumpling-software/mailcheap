-- Spam complaints are per newsletter (contacts.status = 'complained'); the global list keeps hard bounces
-- and manual blocks. Complaint rows from before become their contacts' status where it isn't already.
UPDATE contacts SET status = 'complained', complained_at = coalesce(contacts.complained_at, s.created_at)
FROM suppressions s
WHERE s.email = contacts.email AND s.reason = 'complaint' AND contacts.status <> 'complained'
	AND EXISTS (SELECT 1 FROM messages m WHERE m.contact_id = contacts.id AND m.complained_at IS NOT NULL);
--> statement-breakpoint
DELETE FROM suppressions WHERE reason = 'complaint';
--> statement-breakpoint
ALTER TABLE suppressions ADD CONSTRAINT suppressions_reason_check CHECK (reason IN ('bounce', 'manual'));
