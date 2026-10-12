// Rows carry Dates (and jsonb objects) that client components receive as plain JSON.
export function serialize(value) {
	return JSON.parse(JSON.stringify(value));
}
