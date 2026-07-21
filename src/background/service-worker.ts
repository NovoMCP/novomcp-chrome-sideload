/**
 * MV3 service worker — message router + cache-aware profile fetcher.
 *
 * Two-stage commit lives here:
 *   - GET_PROFILE with peek=true (hover) → cache hit returns; cache miss
 *     returns { ok:true, cached:false, data:null } and the content script
 *     renders a "Look up profile" affordance instead of firing a request.
 *   - GET_PROFILE without peek (click intent) → cache hit returns; cache
 *     miss fetches and persists.
 *
 * Per-tab concurrency cap is enforced on the content-script side (one
 * counter per tab; the worker doesn't need cross-tab arbitration since
 * each tab's content-script independently respects the cap).
 */
import { auth } from '../lib/storage';
import { getCached, setCached } from '../lib/cache';
import {
  getMoleculeProfile, predictPka, predictSolubility, predictBde, predictFrontierOrbitals,
  searchSimilar, predictAdmet, checkComplianceDeep, ApiError$,
} from '../lib/api';
import type { ApiResponse, MoleculeProfile } from '../types';
import type { ComputeTool } from '../lib/messages';

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') {
    // First install — open the popup so the user can paste their key
    chrome.action.openPopup?.().catch(() => { /* no active window yet */ });
  }
});

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  void (async () => {
    if (!isObj(message) || typeof message['type'] !== 'string') {
      sendResponse({ error: 'invalid_message' });
      return;
    }

    switch (message['type']) {
      case 'PING': {
        const key = await auth.getNovoKey();
        sendResponse({ ok: true, authed: Boolean(key) });
        return;
      }

      case 'OPEN_SIDE_PANEL': {
        const tabId = sender.tab?.id;
        const pendingSmiles = (message as Record<string, unknown>)['smiles'];

        // Open the panel FIRST. chrome.sidePanel.open() requires the user
        // gesture budget that came in via the click; any awaited
        // side-effect before this consumes the gesture and the open call
        // fails silently with "user gesture required."
        if (tabId != null) {
          try { await chrome.sidePanel.open({ tabId }); } catch { /* gesture lost */ }
        }

        // Stash AFTER the open call. The panel's mount-time DOM parsing
        // + script init takes ~50-100ms, so this set lands well before
        // the panel's pending-smiles read.
        if (typeof pendingSmiles === 'string' && pendingSmiles) {
          const session = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session
            ?? chrome.storage.local;
          // Fire-and-forget; don't await, don't block the response.
          void session.set({ 'novo.pendingSmiles': pendingSmiles }).catch(() => { /* noop */ });
        }

        sendResponse({ ok: true });
        return;
      }

      case 'SMILES_SELECTED': {
        // Fan-out to any open side-panel pages. Side-panel listens via
        // chrome.runtime.onMessage too — relaying here gives us a single
        // routing layer to attach analytics later.
        try {
          await chrome.runtime.sendMessage(message);
        } catch { /* no listeners — fine */ }
        sendResponse({ ok: true });
        return;
      }

      case 'FETCH_ADMET': {
        const smiles = String((message as Record<string, unknown>)['smiles'] || '').trim();
        if (!smiles) { sendResponse({ ok: false, error: 'missing_smiles' }); return; }
        try {
          const data = await predictAdmet(smiles);
          sendResponse({ ok: true, data });
        } catch (e) {
          if (e instanceof ApiError$) sendResponse({ ok: false, error: e.message, errorCode: e.errorCode, status: e.status });
          else sendResponse({ ok: false, error: e instanceof Error ? e.message : 'fetch_failed' });
        }
        return;
      }

      case 'FETCH_COMPLIANCE': {
        const smiles = String((message as Record<string, unknown>)['smiles'] || '').trim();
        if (!smiles) { sendResponse({ ok: false, error: 'missing_smiles' }); return; }
        try {
          const data = await checkComplianceDeep(smiles);
          sendResponse({ ok: true, data });
        } catch (e) {
          if (e instanceof ApiError$) sendResponse({ ok: false, error: e.message, errorCode: e.errorCode, status: e.status });
          else sendResponse({ ok: false, error: e instanceof Error ? e.message : 'fetch_failed' });
        }
        return;
      }

      case 'SEARCH_SIMILAR': {
        const m = message as Record<string, unknown>;
        const smiles = String(m['smiles'] || '').trim();
        const top_k = typeof m['top_k'] === 'number' ? m['top_k'] : undefined;
        const min_similarity = typeof m['min_similarity'] === 'number' ? m['min_similarity'] : undefined;
        if (!smiles) { sendResponse({ ok: false, error: 'missing_smiles' }); return; }
        try {
          const data = await searchSimilar(smiles, { top_k, min_similarity });
          sendResponse({ ok: true, data });
        } catch (e) {
          if (e instanceof ApiError$) {
            sendResponse({ ok: false, error: e.message, errorCode: e.errorCode, status: e.status });
          } else {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : 'fetch_failed' });
          }
        }
        return;
      }

      case 'INVOKE_COMPUTE': {
        const tool = String((message as Record<string, unknown>)['tool'] || '') as ComputeTool;
        const smiles = String((message as Record<string, unknown>)['smiles'] || '').trim();
        if (!smiles) { sendResponse({ ok: false, tool, error: 'missing_smiles' }); return; }

        const computeKey = await auth.getComputeKey();
        if (!computeKey) {
          sendResponse({ ok: false, tool, error: 'no_compute_key', errorCode: 'no_compute_key' });
          return;
        }

        const dispatch: Record<ComputeTool, (s: string) => Promise<ApiResponse<unknown>>> = {
          predict_pka: predictPka,
          predict_solubility: predictSolubility,
          predict_bde: predictBde,
          predict_frontier_orbitals: predictFrontierOrbitals,
        };
        const fn = dispatch[tool];
        if (!fn) { sendResponse({ ok: false, tool, error: 'unknown_tool' }); return; }

        try {
          const data = await fn(smiles);
          sendResponse({ ok: true, tool, data });
        } catch (e) {
          if (e instanceof ApiError$) {
            sendResponse({ ok: false, tool, error: e.message, errorCode: e.errorCode, status: e.status });
          } else {
            sendResponse({ ok: false, tool, error: e instanceof Error ? e.message : 'fetch_failed' });
          }
        }
        return;
      }

      case 'GET_PROFILE': {
        const smiles = String((message as Record<string, unknown>)['smiles'] || '').trim();
        const peek = Boolean((message as Record<string, unknown>)['peek']);
        if (!smiles) { sendResponse({ ok: false, error: 'missing_smiles' }); return; }

        const cached = await getCached(smiles);
        if (cached) {
          sendResponse({ ok: true, cached: true, data: cached });
          return;
        }
        if (peek) {
          // Hover-only — never fire a server call from a peek
          sendResponse({ ok: true, cached: false, data: null });
          return;
        }

        try {
          const response = await getMoleculeProfile(smiles) as ApiResponse<MoleculeProfile>;
          await setCached(smiles, response);
          sendResponse({ ok: true, cached: false, data: response });
        } catch (e) {
          if (e instanceof ApiError$) {
            sendResponse({ ok: false, error: e.message, errorCode: e.errorCode, status: e.status });
          } else {
            sendResponse({ ok: false, error: e instanceof Error ? e.message : 'fetch_failed' });
          }
        }
        return;
      }

      default:
        sendResponse({ error: 'unknown_type', type: message['type'] });
    }
  })();
  return true; // async response
});

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}
