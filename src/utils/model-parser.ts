export function parseModelString(raw?: string): { providerID: string; modelID: string } | undefined {
  if (!raw || typeof raw !== 'string') return undefined;
  const parts = raw.split('/');
  if (parts.length >= 2) {
    return { providerID: parts[0], modelID: parts.slice(1).join('/') };
  }
  return undefined;
}
