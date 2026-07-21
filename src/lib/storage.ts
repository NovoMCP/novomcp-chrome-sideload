/**
 * Typed wrappers around chrome.storage.local. The wrapped API hides the
 * callback/promise polymorphism Chrome ships with and gives the rest of
 * the codebase a single async/await surface.
 */
import { STORAGE_KEYS } from './constants';
import type { NovoUser } from '../types';

async function get<T>(key: string): Promise<T | undefined> {
  const result = await chrome.storage.local.get(key);
  return result[key] as T | undefined;
}

async function set(key: string, value: unknown): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

async function remove(key: string): Promise<void> {
  await chrome.storage.local.remove(key);
}

export const auth = {
  getNovoKey: () => get<string>(STORAGE_KEYS.novoKey),
  setNovoKey: (key: string) => set(STORAGE_KEYS.novoKey, key),
  clearNovoKey: () => remove(STORAGE_KEYS.novoKey),

  getComputeKey: () => get<string>(STORAGE_KEYS.computeKey),
  setComputeKey: (key: string) => set(STORAGE_KEYS.computeKey, key),
  clearComputeKey: () => remove(STORAGE_KEYS.computeKey),

  getUser: () => get<NovoUser>(STORAGE_KEYS.user),
  setUser: (user: NovoUser) => set(STORAGE_KEYS.user, user),
  clearUser: () => remove(STORAGE_KEYS.user),

  /** Wipe both keys + cached user. Settings persist. */
  signOut: async () => {
    await Promise.all([
      remove(STORAGE_KEYS.novoKey),
      remove(STORAGE_KEYS.computeKey),
      remove(STORAGE_KEYS.user),
    ]);
  },
};
