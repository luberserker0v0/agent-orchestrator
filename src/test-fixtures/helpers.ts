/**
 * Upload an opencode.json config to a conversation via the HTTP API.
 * Used in tests that need a provider / model before sending messages.
 */
export async function uploadOpencodeConfig(
  baseUrl: string,
  conversationId: string,
  config: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/conversations/${conversationId}/config`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  if (res.status !== 204) {
    throw new Error(
      `uploadOpencodeConfig failed: POST /api/conversations/${conversationId}/config returned ${res.status}`,
    );
  }
}
