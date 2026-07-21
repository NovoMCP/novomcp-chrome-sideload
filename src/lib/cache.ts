/**
 * 24h TTL profile cache, keyed by raw SMILES (the canonical form is
 * computed server-side; for hover purposes raw-input keying is fine and
 * avoids a round-trip to canonicalize). Stored in chrome.storage.local
 * (5MB quota — plenty for a few thousand cache entries).
 */
import { STORAGE_KEYS, SMILES_CACHE_TTL_MS } from './constants';
import type { ApiResponse, MoleculeProfile } from '../types';

interface CacheEntry {
  response: ApiResponse<MoleculeProfile>;
  ts: number;
}
type CacheMap = Record<string, CacheEntry>;

async function loadCache(): Promise<CacheMap> {
  const raw = await chrome.storage.local.get(STORAGE_KEYS.smilesCache);
  return (raw[STORAGE_KEYS.smilesCache] as CacheMap) ?? {};
}

async function saveCache(map: CacheMap): Promise<void> {
  await chrome.storage.local.set({ [STORAGE_KEYS.smilesCache]: map });
}

export async function getCached(smiles: string): Promise<ApiResponse<MoleculeProfile> | null> {
  const map = await loadCache();
  const entry = map[smiles];
  if (!entry) return null;
  if (Date.now() - entry.ts > SMILES_CACHE_TTL_MS) {
    delete map[smiles];
    await saveCache(map);
    return null;
  }
  return entry.response;
}

export async function setCached(smiles: string, response: ApiResponse<MoleculeProfile>): Promise<void> {
  const map = await loadCache();
  map[smiles] = { response, ts: Date.now() };
  // Sliding-window eviction: keep at most 2000 entries, drop oldest first
  const keys = Object.keys(map);
  if (keys.length > 2000) {
    const sorted = keys
      .map((k) => [k, (map[k] as CacheEntry).ts] as const)
      .sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < sorted.length - 2000; i++) {
      const k = sorted[i]?.[0];
      if (k) delete map[k];
    }
  }
  await saveCache(map);
}

export async function clearCache(): Promise<void> {
  await chrome.storage.local.remove(STORAGE_KEYS.smilesCache);
}
