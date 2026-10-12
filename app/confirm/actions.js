"use server";

import { after } from "next/server";
import { onContactCreated } from "@/lib/automations/hooks";
import { isSendingEnabled } from "@/lib/config";
import { verifyConfirmToken } from "@/lib/confirmation";
import { confirmContact } from "@/lib/contacts";
import { queueWelcomeEmail } from "@/lib/sending";
import { findNewsletter } from "@/lib/records";

export async function confirmSubscription(token) {
	const reference = verifyConfirmToken(token);
	if (!reference) return { error: "invalid" };

	const { contact, confirmed } = await confirmContact(reference);
	if (contact?.status !== "active") return { error: "invalid" };

	if (confirmed) {
		const newsletter = await findNewsletter(reference.newsletterId);
		// Skipped while the newsletter confirms signups: the confirmation was their one email.
		if (isSendingEnabled()) {
			after(() =>
				queueWelcomeEmail({ newsletter, contact }).catch((error) =>
					console.error(`[confirm] Welcome email for ${contact._id} failed:`, error.message)
				)
			);
		}
		// Confirming is when a confirmed opt-in contact joins: contact_added automations start now.
		after(() =>
			onContactCreated({ newsletter, contact }).catch((error) =>
				console.error(`[confirm] Automations for ${contact._id} failed:`, error.message)
			)
		);
	}
	return { ok: true };
}
