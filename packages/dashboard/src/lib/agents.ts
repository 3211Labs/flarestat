// Static overrides — use this if you want to display a friendlier name
// than whatever you set in the Claude Console. Most of the time leave
// this empty: the dashboard will auto-fetch the key names from Anthropic's
// Admin API and use those.
export const AGENT_NAME_OVERRIDES: Record<string, string> = {
  // 'apikey_01Rj...': 'Polly',
};

export interface AnthropicApiKey {
  id: string;
  name?: string;
  workspace_id?: string | null;
  status?: string;
  created_at?: string;
}

// Build a keyId → display name map from the Admin API response, merged
// with any hard-coded overrides above.
export function buildNameMap(
  keys: AnthropicApiKey[] | null | undefined,
): Record<string, string> {
  const map: Record<string, string> = {};
  for (const key of keys ?? []) {
    if (key.id && key.name) map[key.id] = key.name;
  }
  return { ...map, ...AGENT_NAME_OVERRIDES };
}

export function getAgentName(
  apiKeyId: string | null | undefined,
  nameMap: Record<string, string> = AGENT_NAME_OVERRIDES,
): string {
  if (!apiKeyId) return 'Console / Workbench';
  return nameMap[apiKeyId] ?? `Key …${apiKeyId.slice(-6)}`;
}
