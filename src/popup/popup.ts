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

async function renderConnected(_user: NovoUser | null): Promise<void> {
  const base = await getApiBase();
  const local = isLocalEngineUrl(base);
  $<HTMLElement>('user-engine').textContent = base;
  $<HTMLElement>('user-mode').innerHTML = local
    ? '<span class="badge ok">local single-user</span>'
    : '<span class="badge">hosted / self-hosted</span>';
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
    // Local engines don't return standard NovoUser; treat any non-4xx as
    // "engine reachable, connected." Only unauth OR total unreachable
    // should drop us back to onboarding.
    const base = await getApiBase();
    if (isLocalEngineUrl(base) && err instanceof ApiError$ && !err.isUnauthorized) {
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

  // Persist engine URL first so probeKey targets the right engine.
  if (apiBase && apiBase !== API_BASE_DEFAULT) {
    await chrome.storage.local.set({ [STORAGE_KEYS.apiBase]: apiBase });
  } else {
    await chrome.storage.local.remove(STORAGE_KEYS.apiBase);
  }

  const local = isLocalEngineUrl(apiBase);
  // Only enforce nmcp_ prefix for hosted engines. Local engines accept
  // any bearer token via LocalAuthGate — including blank (we substitute
  // 'local-dev' below).
  if (!local && novoKey && !novoKey.startsWith('nmcp_')) {
    showError('For hosted engines the API key must start with nmcp_. Get one at app.novomcp.com/keys, or use a local engine URL.');
    return;
  }
  if (!local && !novoKey) {
    showError('Hosted engines require an API key. Add one, or point at a local engine URL.');
    return;
  }

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
    // Local engines return a shape probeKey doesn't recognize — but if the
    // engine responded at all, treat it as connected. Only reject on 401
    // (bad key on hosted API) or network failure.
    if (local && err instanceof ApiError$ && !err.isUnauthorized) {
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
