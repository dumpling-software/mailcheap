// For the host's health check: public, and up as soon as the server takes requests.
export function GET() {
	return Response.json({ ok: true });
}
