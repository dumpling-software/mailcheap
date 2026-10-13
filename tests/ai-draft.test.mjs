import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_AI_MODEL, buildMessages, parseDraft, requestDraft } from "../lib/ai-draft.js";

const newsletter = { name: "Poof", fromName: "Rafal" };
const examples = [
	{ subject: "📣 New: Studio app", markdown: "Hi friend,\n\n# Studio app\n\n[[Try it now]](https://dash.poof.bg)" },
	{ subject: "Old", markdown: "x".repeat(20_000) },
	{ subject: "Third", markdown: "never shown" },
];

test("the prompt carries the product, its past emails, the syntax and the copy", () => {
	const [system, user] = buildMessages({
		newsletter,
		examples,
		brief: "We shipped batch mode. CTA: Try it → https://dash.poof.bg/batch",
		imageUrls: ["https://cdn.example.com/a.png"],
	});
	assert.equal(system.role, "system");
	assert.match(system.content, /emails for Poof, sent by its founder Rafal/);
	assert.match(system.content, /\[\[Button label\]\]\(https:/);
	assert.ok(system.content.includes('subject="📣 New: Studio app"'));
	assert.ok(system.content.includes("x".repeat(8_000) + "\n…"), "long examples are cut");
	assert.ok(!system.content.includes("never shown"), "only the last two campaigns");
	assert.match(user.content[0].text, /<copy>\nWe shipped batch mode/);
	assert.match(user.content[0].text, /1\. https:\/\/cdn\.example\.com\/a\.png/);
	assert.deepEqual(user.content[1], { type: "image_url", image_url: { url: "https://cdn.example.com/a.png" } });
});

test("refining sends the current draft and the requested change", () => {
	const [, user] = buildMessages({
		newsletter,
		examples: [],
		brief: "Shorter intro",
		mode: "refine",
		draft: { subject: "S", previewText: "P", markdown: "Hi friend" },
	});
	assert.match(user.content[0].text, /<email>\nHi friend\n<\/email>/);
	assert.match(user.content[0].text, /Shorter intro$/);
});

test("answers are parsed and checked", () => {
	assert.deepEqual(parseDraft('```json\n{"subject":" Hi ","previewText":"P","markdown":" Body "}\n```'), {
		subject: "Hi",
		previewText: "P",
		markdown: "Body",
	});
	assert.throws(() => parseDraft("not json"), /expected format/);
	assert.throws(() => parseDraft('{"subject":"a","previewText":"b","markdown":""}'), /empty/);
});

test("requestDraft calls OpenRouter with the key, the model and a JSON schema", async () => {
	let call;
	const fetchImpl = async (url, init) => {
		call = { url, init, body: JSON.parse(init.body) };
		return { ok: true, json: async () => ({ choices: [{ message: { content: '{"subject":"S","previewText":"P","markdown":"M"}' } }] }) };
	};
	const draft = await requestDraft([{ role: "user", content: "x" }], { env: { OPENROUTER_API_KEY: "sk-test" }, fetchImpl });
	assert.deepEqual(draft, { subject: "S", previewText: "P", markdown: "M" });
	assert.equal(call.url, "https://openrouter.ai/api/v1/chat/completions");
	assert.equal(call.init.headers.authorization, "Bearer sk-test");
	assert.equal(call.body.model, DEFAULT_AI_MODEL);
	assert.equal(call.body.response_format.type, "json_schema");

	const custom = await requestDraft([], { env: { OPENROUTER_API_KEY: "k", OPENROUTER_MODEL: "anthropic/claude-opus-5.5" }, fetchImpl });
	assert.ok(custom);
	assert.equal(call.body.model, "anthropic/claude-opus-5.5");
});

test("errors from OpenRouter and a missing key are reported", async () => {
	await assert.rejects(requestDraft([], { env: {} }), /OPENROUTER_API_KEY/);
	const fetchImpl = async () => ({ ok: false, status: 402, json: async () => ({ error: { message: "Insufficient credits" } }) });
	await assert.rejects(requestDraft([], { env: { OPENROUTER_API_KEY: "k" }, fetchImpl }), /Insufficient credits/);
});
