const CONVERSATION_ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,50}[a-z0-9])?$/;

/**
 * Conversation ids are reused as filesystem segments and Kubernetes resource
 * name suffixes. A single canonical format avoids lossy sanitization and the
 * resulting cross-conversation resource collisions.
 */
export function isValidConversationId(id: string): boolean {
  return CONVERSATION_ID_PATTERN.test(id);
}

export function conversationIdRequirement(): string {
  return 'must be 1-52 lowercase letters, digits, or hyphens, and must start and end with a letter or digit';
}
