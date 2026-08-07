/**
 * Funnel ID tracking — the substrate hook for cross-surface continuity.
 *
 * Every API response from /mcp/tools/{name} carries `usage.funnel_id`. We
 * capture the latest one and persist it
 * in chrome.storage.session so it survives across popup → sidepanel → content
 * script within the same browsing session, but doesn't leak across sessions.
 *
 * The CTAs ("Open in NovoMCP", "Continue in Claude") read from here.
 */
import type { ApiResponse } from '../types';

const STORAGE_KEY = 'novo.currentFunnelId';

// chrome.storage.session is per-browser-session; falls back to .local in
// older Chrome where session is unavailable.
const sessionStorage = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session
  ?? chrome.storage.local;

export async function recordFunnelId(response: ApiResponse<unknown>): Promise<void> {
  const funnelId = response?.usage?.funnel_id;
  if (!funnelId) return;
  try {
    await sessionStorage.set({ [STORAGE_KEY]: funnelId });
  } catch { /* fall through — non-fatal */ }
}

export async function getCurrentFunnelId(): Promise<string | null> {
  try {
    const r = await sessionStorage.get(STORAGE_KEY);
    return (r[STORAGE_KEY] as string) ?? null;
  } catch {
    return null;
  }
}

export async function clearFunnelId(): Promise<void> {
  try { await sessionStorage.remove(STORAGE_KEY); } catch { /* noop */ }
}

/** Dashboard URL with the funnel pre-selected and auto-expanded. */
export function dashboardUrl(funnelId: string): string {
  return `https://app.novomcp.com/audit/pipelines?funnel_id=${encodeURIComponent(funnelId)}`;
}

/**
 * Continue in Claude — there's no deep-link receiver in Claude.ai, so we
 * give the user a copy-to-clipboard prompt template instead. They paste it
 * into a new Claude conversation, NovoMCP-side `load_session`
 * picks up the funnel_id and threads the prior audit forward.
 */
export function claudeHandoffPrompt(funnelId: string, smiles?: string): string {
  const lines = [
    `Continue NovoMCP funnel ${funnelId}.`,
    smiles ? `Last molecule looked at: ${smiles}` : '',
    `Load the prior audit with get_funnel_audit, then continue analysis from where the Chrome extension left off.`,
  ].filter(Boolean);
  return lines.join('\n');
}
