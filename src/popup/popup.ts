import { auth } from '../lib/storage';
import { probeKey, validateKey, ApiError$ } from '../lib/api';
import { STORAGE_KEYS, API_BASE_DEFAULT, getApiBase } from '../lib/constants';
import type { NovoUser } from '../types';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const states = {
  loading: $<HTMLElement>('state-loading'),
  onboarding: $<HTMLElement>('state-onboarding'),
  connected: $<HTMLElement>('state-connected'),
};

function show(state: keyof typeof states): void {
  for (const [name, el] of Object.entries(states)) {
    el.hidden = name !== state;
  }
}

function showError(message: string): void {
  const el = $<HTMLElement>('error-msg');
  el.textContent = message;
  el.hidden = false;
}

function clearError(): void {
  const el = $<HTMLElement>('error-msg');
  el.textContent = '';
  el.hidden = true;
}

function isLocalEngineUrl(url: string): boolean {
  return /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(url);
}

/**
 * Engines off this machine (e.g. a DGX Spark on the LAN at
 * http://spark-xxxx.local:8018) aren't covered by the manifest's static
 * localhost host_permissions, and the engine's CORS allow-list only pins the
 * Web Store extension ID — so without a host grant every fetch is blocked.
 * Ask for exactly the engine's origin (from optional_host_permissions); Chrome
 * resolves immediately with no prompt if it's already granted. Must run inside
 * the Connect click's user gesture, before any other await.
 */
async function ensureHostPermission(apiBase: string): Promise<boolean> {
  let url: URL;
  try {
    url = new URL(apiBase);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  return chrome.permissions.request({ origins: [`${url.protocol}//${url.hostname}/*`] });
}

async function renderConnected(_user: NovoUser | null): Promise<void> {
  const base = await getApiBase();
  const local = isLocalEngineUrl(base);
  $<HTMLElement>('user-engine').textContent = base;
  $<HTMLElement>('user-mode').innerHTML = local
    ? '<span class="badge ok">local single-user</span>'
    : '<span class="badge">self-hosted</span>';
  show('connected');
}

async function bootstrap(): Promise<void> {
  show('loading');
  const key = await auth.getNovoKey();
  if (!key) {
    show('onboarding');
    return;
  }

  try {
    const user = await validateKey();
    await auth.setUser(user);
    await renderConnected(user);
  } catch (err) {
    // Self-hosted engines (localhost or LAN) don't return a standard NovoUser;
    // any non-401 response means "engine reachable, connected." Only unauth
    // OR total unreachable should drop us back to onboarding.
    if (err instanceof ApiError$ && !err.isUnauthorized) {
      await renderConnected(null);
      return;
    }
    if (err instanceof ApiError$ && err.isUnauthorized) {
      await auth.signOut();
      show('onboarding');
      showError('Saved key is no longer valid. Please reconnect.');
      return;
    }
    const cached = await auth.getUser();
    if (cached) {
      await renderConnected(cached);
    } else {
      show('onboarding');
      showError('Unable to reach the engine. Check the URL and that the engine is running.');
    }
  }
}

async function handleConnect(event: Event): Promise<void> {
  event.preventDefault();
  clearError();
  const apiBase = ($<HTMLInputElement>('api-base')).value.trim() || API_BASE_DEFAULT;
  const novoKey = ($<HTMLInputElement>('novo-key')).value.trim();

  // Host grant first — permissions.request needs the click's user gesture.
  let granted = false;
  try {
    granted = await ensureHostPermission(apiBase);
  } catch {
    granted = false;
  }
  if (!granted) {
    showError('Chrome needs permission to reach that engine URL. Check the URL and allow access when prompted.');
    return;
  }

  // Persist engine URL so probeKey targets the right engine.
  if (apiBase && apiBase !== API_BASE_DEFAULT) {
    await chrome.storage.local.set({ [STORAGE_KEYS.apiBase]: apiBase });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.apiBase);
  }

  // The API key is optional. A self-hosted engine accepts any bearer token via
  // LocalAuthGate — including blank (we substitute 'local-dev' below). Supply a
  // key only if you point at an engine that requires auth (e.g. a compliance service).

  const btn = $<HTMLButtonElement>('connect-btn');
  btn.disabled = true;
  btn.textContent = 'Connecting…';

  const effectiveKey = novoKey || 'local-dev';
  try {
    const user = await probeKey(effectiveKey);
    await auth.setNovoKey(effectiveKey);
    await auth.setUser(user);
    await renderConnected(user);
  } catch (err) {
    // Self-hosted engines (localhost or LAN) return a shape probeKey doesn't
    // recognize — but if the engine responded at all, treat it as connected.
    // Only reject on 401 (engine requires a key) or network failure.
    if (err instanceof ApiError$ && !err.isUnauthorized) {
      await auth.setNovoKey(effectiveKey);
      await renderConnected(null);
      return;
    }
    const msg = err instanceof ApiError$ && err.isUnauthorized
      ? 'Key rejected. Check the key and engine URL.'
      : err instanceof ApiError$
        ? `Could not connect (${err.status}): ${err.message}`
        : 'Network error. Is the engine running at that URL?';
    showError(msg);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Connect';
  }
}

async function handleSignOut(): Promise<void> {
  await auth.signOut();
  await chrome.storage.local.remove(STORAGE_KEYS.apiBase);
  ($<HTMLInputElement>('novo-key')).value = '';
  ($<HTMLInputElement>('api-base')).value = 'http://localhost:8018';
  show('onboarding');
}

async function handleOpenSidebar(): Promise<void> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  const tabId = tabs[0]?.id;
  if (tabId != null) {
    await chrome.sidePanel.open({ tabId });
    window.close();
  }
}

document.addEventListener('DOMContentLoaded', () => {
  $<HTMLFormElement>('onboarding-form').addEventListener('submit', handleConnect);
  $<HTMLButtonElement>('signout-btn').addEventListener('click', handleSignOut);
  $<HTMLButtonElement>('open-sidebar-btn').addEventListener('click', handleOpenSidebar);
  void bootstrap();
});
