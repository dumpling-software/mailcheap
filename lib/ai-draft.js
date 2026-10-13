// "Write with AI": Claude (through OpenRouter) turns pasted copy, links and pictures into a campaign
// in the product's Markdown, following its past emails. The product's template supplies the design,
// so the model only writes the text part.
export const DEFAULT_AI_MODEL = "anthropic/claude-sonnet-5.5";
const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const TIMEOUT_MS = 120_000;
// Past campaigns shown as examples; enough for the voice and structure, not the whole archive.
const MAX_EXAMPLES = 2;
const MAX_EXAMPLE_CHARS = 8_000;
export const MAX_BRIEF_CHARS = 20_000;
export const MAX_IMAGES = 10;

const RESPONSE_SCHEMA = {
	type: "object",
	additionalProperties: false,
	required: ["subject", "previewText", "markdown"],
	properties: {
		subject: { type: "string", description: "Email subject line" },
		previewText: { type: "string", description: "Inbox preview text, one short sentence" },
		markdown: { type: "string", description: "The email body in the Markdown described" },
	},
};

const SYNTAX = `Markdown you can use:
- Paragraphs, **bold**, *italic*, [links](https://…), \`code\`, lists.
- Headings: "# " for a main section title, "## " for smaller ones. Follow the examples' levels.
- Pictures: ![short description](https://…) on a line of its own.
- Buttons: [[Button label]](https://…) on a line of its own, with blank lines around it.
- A gray box around a block: a line ":::box", the content, then a line ":::".
No HTML, no tables.`;

function trimExample(markdown) {
	return markdown.length > MAX_EXAMPLE_CHARS ? `${markdown.slice(0, MAX_EXAMPLE_CHARS)}\n…` : markdown;
}

export function buildSystemPrompt({ newsletter, examples = [] }) {
	const name = newsletter?.name || "the product";
	const shown = examples.filter((example) => example?.markdown?.trim()).slice(0, MAX_EXAMPLES);
	const exampleText = shown
		.map((example, index) => `<example index="${index + 1}" subject="${example.subject ?? ""}">\n${trimExample(example.markdown)}\n</example>`)
		.join("\n\n");
	return `You format product update emails for ${name}, sent by its founder${newsletter?.fromName ? ` ${newsletter.fromName}` : ""}.

The person gives you the copy (and maybe links, button labels and pictures). Turn it into the body of one email in ${name}'s usual structure and voice, as shown in the past emails below.

Rules:
- Keep the person's wording. Fix obvious typos and split it into sections, but don't rewrite, add claims, or invent features, numbers, prices or links.
- Only use links and pictures the person gave you. Put each picture where it fits the text, usually above the section it shows.
- Use a button for each main call to action the person asks for; a link inside the text is fine for the rest.
- Open and close like the examples (greeting, PS line), but leave out the sign-off, the founder card and the unsubscribe footer: the template adds them.
- Write a subject and preview text in the style of the examples, unless the person gives them.

${SYNTAX}
${exampleText ? `\nPast ${name} emails:\n\n${exampleText}` : ""}`;
}

// "create" starts from the brief; "refine" changes the current draft as the person asks.
export function buildMessages({ newsletter, examples, brief, imageUrls = [], mode = "create", draft = null }) {
	const images = imageUrls.slice(0, MAX_IMAGES);
	const imageList = images.length
		? `\n\nPictures to use (in this order unless the copy says otherwise):\n${images.map((url, index) => `${index + 1}. ${url}`).join("\n")}`
		: "";
	const request =
		mode === "refine" && draft
			? `Here is the current email.\n\nSubject: ${draft.subject}\nPreview text: ${draft.previewText}\n\n<email>\n${draft.markdown}\n</email>\n\nChange it as follows, and keep everything else as it is:\n${brief}${imageList}`
			: `Format this into an email:\n\n<copy>\n${brief}\n</copy>${imageList}`;
	return [
		{ role: "system", content: buildSystemPrompt({ newsletter, examples }) },
		{
			role: "user",
			content: [
				{ type: "text", text: request },
				// Claude sees the pictures too, to place them and describe them in the alt text.
				...images.map((url) => ({ type: "image_url", image_url: { url } })),
			],
		},
	];
}

export function parseDraft(content) {
	const text = String(content ?? "").trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
	let draft;
	try {
		draft = JSON.parse(text);
	} catch {
		throw new Error("The AI answer wasn't in the expected format, try again");
	}
	if (typeof draft?.markdown !== "string" || !draft.markdown.trim()) throw new Error("The AI returned an empty email");
	return {
		subject: String(draft.subject ?? "").trim().slice(0, 200),
		previewText: String(draft.previewText ?? "").trim().slice(0, 300),
		markdown: draft.markdown.trim(),
	};
}

export async function requestDraft(messages, { env = process.env, fetchImpl = fetch } = {}) {
	const apiKey = env.OPENROUTER_API_KEY?.trim();
	if (!apiKey) throw new Error("Set OPENROUTER_API_KEY to use AI drafts");
	const response = await fetchImpl(ENDPOINT, {
		method: "POST",
		headers: {
			authorization: `Bearer ${apiKey}`,
			"content-type": "application/json",
			"x-title": "Mailcheap",
		},
		body: JSON.stringify({
			model: env.OPENROUTER_MODEL?.trim() || DEFAULT_AI_MODEL,
			messages,
			max_tokens: 8_000,
			reasoning: { effort: "low" },
			response_format: { type: "json_schema", json_schema: { name: "email", strict: true, schema: RESPONSE_SCHEMA } },
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
	const result = await response.json().catch(() => ({}));
	if (!response.ok || result.error) {
		const message = result.error?.message || `OpenRouter answered ${response.status}`;
		throw new Error(`AI draft failed: ${message}`);
	}
	return parseDraft(result.choices?.[0]?.message?.content);
}
