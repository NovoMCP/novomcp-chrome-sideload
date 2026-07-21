/**
 * Single source of truth for cross-cutting client constants.
 *
 * SIDELOAD BUILD — the sideload/OSS variant of the NovoMCP Chrome extension.
 * Differs from the production build (Chrome Web Store, points at
 * api.novomcp.com) in three ways:
 *
 *   1. API_BASE resolves via getApiBase() at call time. Reads from
 *      chrome.storage.local first (so the user's engine URL setting wins),
 *      falls back to the hosted API for users who paste an nmcp_* key.
 *   2. manifest.json includes http://localhost:* + http://127.0.0.1:* in
 *      host_permissions so a local NovoMCP engine on :8018 is reachable.
 *   3. Popup surfaces the engine-URL setting so users don't have to edit
 *      chrome.storage manually.
 *
 * SURFACE_TAG is sent as the X-Novo-Surface header on every API call —
 * namespaces per-surface sessions for the audit log.
 */
export const SURFACE_TAG = 'chrome-ext-sideload-v1';
export const UA_PREFIX = 'NovoMCP-ChromeExt-Sideload/0.1.0';

// Default engine URL — used when the user hasn't set a custom one.
// Points at the hosted API so nmcp_* keys work out of the box; users
// running OSS locally point at http://localhost:8018.
export const API_BASE_DEFAULT = 'https://api.novomcp.com';

// Backwards-compat alias for callers that still import API_BASE directly.
// New code should call getApiBase() so runtime settings take effect.
export const API_BASE = API_BASE_DEFAULT;

export const STORAGE_KEYS = {
  novoKey: 'novo.key',
  computeKey: 'novo.computeKey',
  user: 'novo.user',
  smilesCache: 'novo.smilesCache',
  settings: 'novo.settings',
  apiBase: 'novo.apiBase',
} as const;

export const SMILES_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Resolve the engine URL at call time. Reads chrome.storage first, falls
 * back to API_BASE_DEFAULT. Handles the case where chrome.storage isn't
 * available (unit tests, non-extension contexts) by returning the default.
 * Trailing slashes are stripped so ${base}${path} produces a clean URL.
 */
export async function getApiBase(): Promise<string> {
  if (typeof chrome === 'undefined' || !chrome.storage?.local) {
    return API_BASE_DEFAULT;
  }
  try {
    const result = await chrome.storage.local.get(STORAGE_KEYS.apiBase);
    const stored = result[STORAGE_KEYS.apiBase];
    if (typeof stored === 'string' && stored.trim().length > 0) {
      return stored.trim().replace(/\/$/, '');
    }
  } catch {
    // fall through to default
  }
  return API_BASE_DEFAULT;
}
