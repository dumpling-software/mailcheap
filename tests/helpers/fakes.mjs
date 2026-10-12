// Stand-ins for SES and QStash that record what the app sends.
export function fakeSes() {
	const sent = [];
	return {
		sent,
		async send(command) {
			const input = command.input;
			if (input.Destination) {
				sent.push(input);
				return { MessageId: `ses-${crypto.randomUUID()}` };
			}
			return {};
		},
	};
}

export function fakeQStash() {
	const published = [];
	return {
		published,
		async batchJSON(requests) {
			published.push(...requests);
			return requests.map((_, index) => ({ messageId: `q-${published.length + index}` }));
		},
		async publishJSON(request) {
			published.push(request);
			return { messageId: `q-${published.length}` };
		},
	};
}
