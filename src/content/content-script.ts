/**
 * Content script — SMILES detection + hover card + side-panel handoff.
 *
 * Hover-firing discipline (per Novo_Dist_Play.md §3):
 *   - 300ms debounce on hover events; fast cursor scans across the page never fire.
 *   - Two-stage commit: hover only renders cached profiles. On cache miss the
 *     card shows the SMILES + a "Look up profile" affordance — the actual API
 *     call defers until the user clicks the affordance, the underlined SMILES,
 *     or "Open in sidebar." Hover at most reads chrome.storage.local; server
 *     work happens only on intent.
 *   - Per-tab concurrency cap of 5 in-flight server calls; clicks past the cap
 *     queue with a small spinner badge.
 *
 * Style isolation: hover card lives in a shadow root attached to a host
 * element appended to body, so page CSS can't bleed in.
 */
import { findSmilesCandidates, isLikelySmiles, type SmilesMatch } from '../lib/smiles';
import type { GetProfileResponse, GetProfileRequest, OpenSidePanelRequest, SmilesSelectedEvent } from '../lib/messages';
import type { ApiResponse, MoleculeProfile } from '../types';

const SMILES_ATTR = 'data-novomcp-smiles';
const HOVER_DEBOUNCE_MS = 300;
const HIDE_DELAY_MS = 120;
const PER_TAB_CONCURRENCY_CAP = 5;
const MAX_INITIAL_CANDIDATES = 500;

// ─────────────────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────────────────

let candidatesWrapped = 0;
const inFlight = new Set<string>();
const pendingQueue: Array<{ smiles: string; intent: () => void }> = [];

/**
 * "Extension context invalidated" surfaces whenever this content script
 * was injected by a prior version of the extension and the user has since
 * reloaded the extension (npm run build → unpack-reload). Old content
 * scripts stay pinned to the old service worker until the host page
 * reloads them. Detect once, stop firing, and surface a one-time banner
 * with a Reload button so the failure mode reads as planned, not broken.
 */
let extensionContextLost = false;

function isContextInvalidated(err: unknown): boolean {
  if (!err) return false;
  const msg = err instanceof Error ? err.message : String(err);
  return /context invalidated|Extension context|message port closed/i.test(msg);
}

async function safeSend<T>(msg: unknown): Promise<T | null> {
  if (extensionContextLost) return null;
  try {
    // chrome.runtime.id throws synchronously if the context is gone
    void chrome.runtime.id;
    return await chrome.runtime.sendMessage(msg) as T;
  } catch (err) {
    if (isContextInvalidated(err)) {
      onContextLost();
      return null;
    }
    throw err;
  }
}

function onContextLost(): void {
  if (extensionContextLost) return;
  extensionContextLost = true;
  hoverCard?.hide();
  showReloadBanner();
}

function showReloadBanner(): void {
  if (document.querySelector('[data-novomcp-host="reload-banner"]')) return;
  const host = document.createElement('div');
  host.setAttribute('data-novomcp-host', 'reload-banner');
  host.style.cssText =
    'position:fixed;bottom:16px;right:16px;z-index:2147483647;pointer-events:auto;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  shadow.innerHTML = `
    <style>
      .banner {
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 12px;
        color: #2D2A26;
        background: #FFFFFF;
        border: 1px solid #E8E4DE;
        box-shadow: 0 6px 24px -8px rgba(45, 42, 38, 0.18);
        padding: 12px 14px;
        max-width: 300px;
        line-height: 1.5;
      }
      @media (prefers-color-scheme: dark) {
        .banner { color: #E8E4DE; background: #242120; border-color: #3A3632; }
      }
      .head { font-weight: 600; margin-bottom: 4px; font-size: 12px; }
      .row { display: flex; gap: 8px; margin-top: 8px; }
      button {
        font: inherit; font-size: 11px; padding: 4px 10px;
        border: 1px solid #B8704B; background: #B8704B; color: #FFF;
        cursor: pointer; border-radius: 0;
      }
      button.secondary { background: transparent; border-color: #E8E4DE; color: inherit; }
      @media (prefers-color-scheme: dark) {
        button { background: #C9845E; border-color: #C9845E; color: #1C1A17; }
        button.secondary { background: transparent; border-color: #3A3632; color: inherit; }
      }
    </style>
    <div class="banner">
      <div class="head">NovoMCP updated</div>
      <div>Reload this page to continue using SMILES hover lookups.</div>
      <div class="row">
        <button data-action="reload">Reload page</button>
        <button data-action="dismiss" class="secondary">Dismiss</button>
      </div>
    </div>
  `;
  shadow.querySelector('[data-action="reload"]')?.addEventListener('click', () => location.reload());
  shadow.querySelector('[data-action="dismiss"]')?.addEventListener('click', () => host.remove());
}

// ─────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────

(async () => {
  const r = await safeSend<{ ok: true; authed: boolean }>({ type: 'PING' });
  if (!r) return; // context lost or worker unavailable
  document.documentElement.dataset['novomcp'] = r.authed ? 'authed' : 'idle';
  if (!r.authed) return; // user hasn't connected — don't decorate the page

  initialScan();
  startMutationObserver();
  startHoverHandling();
})();

// ─────────────────────────────────────────────────────────────────────
// DOM walking — wrap SMILES substrings in <span data-novomcp-smiles>
// ─────────────────────────────────────────────────────────────────────

function initialScan(): void {
  // Per-host structured extraction first — these selectors anchor the
  // canonical SMILES on PubChem / ChEMBL pages and are more reliable than
  // regex over the body text. Regex extraction still runs afterwards to
  // catch any additional SMILES strings (related-records, supplementary).
  applyStructuredHints();
  walkAndWrap(document.body);
}

/**
 * Per-host structured SMILES hints. Wraps known canonical-SMILES locations
 * with the `novomcp-smiles` span before the broader text walker runs, so
 * the primary surfaces (PubChem compound page) get a guaranteed match.
 */
function applyStructuredHints(): void {
  const host = location.hostname;
  if (host.endsWith('pubchem.ncbi.nlm.nih.gov')) {
    pubchemHints();
  } else if (host.endsWith('ebi.ac.uk')) {
    chemblHints();
  }
}

function pubchemHints(): void {
  // PubChem compound page: the canonical SMILES appears as a section like
  //   <section data-pdg-section-name="Canonical SMILES">…<p>CC(=O)…</p></section>
  // and also in <meta property="og:url" content="https://pubchem.ncbi.nlm.nih.gov/compound/2244">
  // (CID-only, not SMILES). The reliable anchor is the section's text content.
  const sections = document.querySelectorAll('section, div[role="region"]');
  for (const section of Array.from(sections).slice(0, 100)) {
    const heading = section.querySelector('h2, h3, [data-pdg-section-name]');
    const text = (heading?.textContent || '').trim().toLowerCase();
    if (!text.includes('smiles')) continue;
    // The SMILES text is in a <p> or <td> child — wrap it as a candidate
    const candidates = section.querySelectorAll('p, td, span');
    for (const candidate of Array.from(candidates).slice(0, 8)) {
      const txt = (candidate.textContent || '').trim();
      if (txt.length < 6 || txt.length > 300) continue;
      if (!isLikelySmiles(txt)) continue;
      // Wrap the entire element's text node atomically so the broader
      // walker doesn't try to re-match a substring.
      if (candidate.querySelector('.novomcp-smiles')) continue;
      const span = document.createElement('span');
      span.className = 'novomcp-smiles';
      span.setAttribute(SMILES_ATTR, txt);
      span.textContent = txt;
      span.style.cssText = 'border-bottom:1px dashed currentColor;cursor:help;text-underline-offset:2px;opacity:0.92;';
      candidate.textContent = '';
      candidate.appendChild(span);
      candidatesWrapped++;
      break;
    }
  }
}

function chemblHints(): void {
  // ChEMBL compound page commonly exposes SMILES in elements with
  // class "compound-smiles" or in a .compound-card descendant.
  const nodes = document.querySelectorAll('.compound-smiles, [data-canonical-smiles]');
  for (const node of Array.from(nodes).slice(0, 20)) {
    const explicit = node.getAttribute('data-canonical-smiles');
    const txt = (explicit || node.textContent || '').trim();
    if (!isLikelySmiles(txt)) continue;
    if (node.querySelector('.novomcp-smiles')) continue;
    const span = document.createElement('span');
    span.className = 'novomcp-smiles';
    span.setAttribute(SMILES_ATTR, txt);
    span.textContent = txt;
    span.style.cssText = 'border-bottom:1px dashed currentColor;cursor:help;text-underline-offset:2px;opacity:0.92;';
    node.textContent = '';
    node.appendChild(span);
    candidatesWrapped++;
  }
}

function walkAndWrap(root: Node): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) => {
      const parent = (node as Text).parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (parent.closest('script, style, noscript, textarea, input, [contenteditable="true"]')) {
        return NodeFilter.FILTER_REJECT;
      }
      if (parent.classList.contains('novomcp-smiles')) return NodeFilter.FILTER_REJECT;
      // Skip our own hover card host (and its descendants if any leaked)
      if (parent.closest('[data-novomcp-host]')) return NodeFilter.FILTER_REJECT;
      const txt = node.nodeValue ?? '';
      if (txt.length < 6) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });

  const nodes: Text[] = [];
  let n: Node | null;
  while ((n = walker.nextNode())) nodes.push(n as Text);

  for (const tn of nodes) {
    if (candidatesWrapped >= MAX_INITIAL_CANDIDATES) break;
    wrapSmilesInTextNode(tn);
  }
}

function wrapSmilesInTextNode(node: Text): void {
  const text = node.nodeValue ?? '';
  const matches = findSmilesCandidates(text);
  if (matches.length === 0) return;

  const frag = document.createDocumentFragment();
  let lastEnd = 0;
  for (const m of matches) {
    if (candidatesWrapped >= MAX_INITIAL_CANDIDATES) break;
    if (m.start > lastEnd) {
      frag.appendChild(document.createTextNode(text.slice(lastEnd, m.start)));
    }
    frag.appendChild(makeSpan(m));
    lastEnd = m.end;
    candidatesWrapped++;
  }
  if (lastEnd < text.length) {
    frag.appendChild(document.createTextNode(text.slice(lastEnd)));
  }
  if (frag.childNodes.length > 0) {
    node.parentNode?.replaceChild(frag, node);
  }
}

function makeSpan(match: SmilesMatch): HTMLElement {
  const span = document.createElement('span');
  span.className = 'novomcp-smiles';
  span.setAttribute(SMILES_ATTR, match.smiles);
  span.textContent = match.smiles;
  // Inline style — cheap, no extra fetched stylesheet, survives page CSS
  // (mostly). High enough specificity to win the cascade in most cases.
  span.style.cssText =
    'border-bottom:1px dashed currentColor;cursor:help;text-underline-offset:2px;opacity:0.92;';
  return span;
}

function startMutationObserver(): void {
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const added of m.addedNodes) {
        if (added.nodeType === Node.ELEMENT_NODE) {
          // Skip our own additions
          const el = added as HTMLElement;
          if (el.hasAttribute('data-novomcp-host') || el.classList?.contains('novomcp-smiles')) continue;
          walkAndWrap(added);
        }
      }
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });
}

// ─────────────────────────────────────────────────────────────────────
// Hover card — shadow-DOM-isolated
// ─────────────────────────────────────────────────────────────────────

let hoverCard: HoverCard | null = null;
let hoverTarget: HTMLElement | null = null;
let hoverTimeout: number | null = null;
let hideTimeout: number | null = null;

interface HoverCard {
  host: HTMLElement;
  shadow: ShadowRoot;
  setSmiles(smiles: string, anchor: HTMLElement): void;
  setProfile(smiles: string, response: ApiResponse<MoleculeProfile>): void;
  setLookupAffordance(smiles: string): void;
  setLoading(): void;
  setError(message: string): void;
  hide(): void;
  visible(): boolean;
}

function getHoverCard(): HoverCard {
  if (hoverCard) return hoverCard;

  const host = document.createElement('div');
  host.setAttribute('data-novomcp-host', 'hover-card');
  host.style.cssText = 'position:absolute;z-index:2147483647;pointer-events:none;';
  document.body.appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host { all: initial; }
      .card {
        pointer-events: auto;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
        font-size: 12px;
        line-height: 1.5;
        color: #2D2A26;
        background: #FFFFFF;
        border: 1px solid #E8E4DE;
        box-shadow: 0 6px 24px -8px rgba(45, 42, 38, 0.15), 0 1px 3px rgba(45, 42, 38, 0.08);
        padding: 12px 14px;
        min-width: 240px;
        max-width: 320px;
        border-radius: 0;
      }
      @media (prefers-color-scheme: dark) {
        .card {
          color: #E8E4DE;
          background: #242120;
          border-color: #3A3632;
          box-shadow: 0 6px 24px -8px rgba(0,0,0,0.6), 0 1px 3px rgba(0,0,0,0.4);
        }
      }
      .smiles {
        font-family: ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace;
        font-size: 11px;
        word-break: break-all;
        color: #6B6560;
        padding-bottom: 8px;
        border-bottom: 1px solid #E8E4DE;
        margin-bottom: 8px;
      }
      @media (prefers-color-scheme: dark) {
        .smiles { color: #A39E98; border-bottom-color: #3A3632; }
      }
      .props {
        display: grid;
        grid-template-columns: max-content 1fr;
        gap: 4px 12px;
      }
      .props dt {
        color: #9C9690;
        font-size: 10px;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        align-self: center;
      }
      .props dd { margin: 0; font-variant-numeric: tabular-nums; }
      .badge {
        display: inline-block;
        padding: 1px 6px;
        font-size: 10px;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        background: #F3F0EB;
        color: #6B6560;
      }
      @media (prefers-color-scheme: dark) {
        .badge { background: #2E2B28; color: #A39E98; }
      }
      .badge.ok { background: #E5EFE5; color: #4A7C59; }
      .badge.warn { background: #FBF0E0; color: #B8704B; }
      .badge.err  { background: #FBECEC; color: #C53030; }
      @media (prefers-color-scheme: dark) {
        .badge.ok { background: #2A3A2F; color: #5E9E6E; }
        .badge.warn { background: #3A2D20; color: #C9845E; }
        .badge.err { background: #2E1A1A; color: #D65454; }
      }
      .actions {
        margin-top: 10px;
        padding-top: 8px;
        border-top: 1px solid #E8E4DE;
        display: flex;
        gap: 8px;
      }
      @media (prefers-color-scheme: dark) {
        .actions { border-top-color: #3A3632; }
      }
      button {
        font: inherit;
        padding: 6px 10px;
        border: 1px solid #E8E4DE;
        background: transparent;
        color: #2D2A26;
        cursor: pointer;
        border-radius: 0;
      }
      button.primary {
        background: #B8704B;
        border-color: #B8704B;
        color: #FFFFFF;
      }
      button:hover { filter: brightness(0.97); }
      @media (prefers-color-scheme: dark) {
        button { color: #E8E4DE; border-color: #3A3632; }
        button.primary { background: #C9845E; border-color: #C9845E; color: #1C1A17; }
      }
      .loading::after {
        content: '';
        display: inline-block;
        width: 8px; height: 8px;
        border-radius: 50%;
        background: #B8704B;
        animation: pulse 1s infinite ease-in-out;
        margin-left: 6px;
        vertical-align: middle;
      }
      @keyframes pulse { 0%, 100% { opacity: 0.4; } 50% { opacity: 1; } }
      .error { color: #C53030; }
      @media (prefers-color-scheme: dark) {
        .error { color: #D65454; }
      }
    </style>
    <div class="card" part="card"></div>
  `;
  const cardEl = shadow.querySelector('.card') as HTMLElement;

  // Keep the card open while the cursor is inside it
  cardEl.addEventListener('mouseenter', () => {
    if (hideTimeout) { window.clearTimeout(hideTimeout); hideTimeout = null; }
  });
  cardEl.addEventListener('mouseleave', () => scheduleHide());

  hoverCard = {
    host,
    shadow,
    visible: () => host.style.display !== 'none' && host.isConnected,
    hide: () => { host.style.display = 'none'; hoverTarget = null; },
    setSmiles(smiles, anchor) {
      hoverTarget = anchor;
      positionAtAnchor(host, anchor);
      host.style.display = '';
    },
    setLoading() {
      cardEl.innerHTML = `<div class="loading">Looking up</div>`;
    },
    setError(message) {
      cardEl.innerHTML = `<div class="error">${escapeHtml(message)}</div>`;
    },
    setLookupAffordance(smiles) {
      cardEl.innerHTML = `
        <div class="smiles">${escapeHtml(smiles)}</div>
        <div class="actions">
          <button class="primary" data-action="lookup">Look up profile (1cr)</button>
          <button data-action="sidebar">Open sidebar</button>
        </div>
      `;
      cardEl.querySelector('[data-action="lookup"]')?.addEventListener('click', () => requestProfile(smiles));
      cardEl.querySelector('[data-action="sidebar"]')?.addEventListener('click', () => openSidebarFor(smiles));
    },
    setProfile(smiles, response) {
      const p = response.result;
      const props = p.properties || {};
      const compliance = (p.compliance || {}) as Record<string, unknown>;
      const status = (compliance['status'] as string) ?? 'unknown';
      const inDb = p.in_database;
      const cost = response.usage?.credits ?? 0;

      cardEl.innerHTML = `
        <div class="smiles">${escapeHtml(smiles)}</div>
        <dl class="props">
          ${propRow('MW', formatNum(props['molecular_weight']))}
          ${propRow('LogP', formatNum(props['logp']))}
          ${propRow('QED', formatNum(props['qed']))}
          ${propRow('TPSA', formatNum(props['tpsa']))}
          ${propRow('HBD/HBA', `${formatInt(props['hbd_count'] ?? props['hbd'])} / ${formatInt(props['hba_count'] ?? props['hba'])}`)}
          ${propRow('Rot bonds', formatInt(props['rotatable_bond_count'] ?? props['rotatable_bonds']))}
          ${propRow('Status', `<span class="badge ${complianceBadgeClass(status)}">${escapeHtml(status)}</span>`)}
          ${propRow('Source', `<span class="badge">${inDb ? 'cached' : 'computed'}</span> ${cost === 0 ? '<span class="badge ok">free</span>' : ''}`)}
        </dl>
        <div class="actions">
          <button class="primary" data-action="sidebar">Open in sidebar</button>
        </div>
      `;
      cardEl.querySelector('[data-action="sidebar"]')?.addEventListener('click', () => openSidebarFor(smiles));
    },
  };

  return hoverCard;
}

function propRow(label: string, value: string): string {
  return `<dt>${escapeHtml(label)}</dt><dd>${value}</dd>`;
}

function formatNum(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(2);
}

function formatInt(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return Math.round(v).toString();
}

function complianceBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'clear' || s === 'ok' || s === 'pass') return 'ok';
  if (s === 'controlled' || s === 'flagged' || s === 'warn') return 'warn';
  if (s === 'blocked' || s === 'fail' || s === 'rejected') return 'err';
  return '';
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function positionAtAnchor(host: HTMLElement, anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const top = window.scrollY + rect.bottom + 6;
  const left = Math.max(8, Math.min(window.scrollX + rect.left, window.scrollX + window.innerWidth - 340));
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;
}

// ─────────────────────────────────────────────────────────────────────
// Hover handling — debounce + two-stage commit
// ─────────────────────────────────────────────────────────────────────

function startHoverHandling(): void {
  document.addEventListener('mouseover', onMouseover, true);
  document.addEventListener('mouseout', onMouseout, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('scroll', onScroll, true);
}

function onMouseover(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target) return;
  const span = target.closest?.('.novomcp-smiles') as HTMLElement | null;
  if (!span) return;
  const smiles = span.getAttribute(SMILES_ATTR);
  if (!smiles || !isLikelySmiles(smiles)) return;

  if (hoverTimeout) window.clearTimeout(hoverTimeout);
  if (hideTimeout) { window.clearTimeout(hideTimeout); hideTimeout = null; }

  hoverTimeout = window.setTimeout(() => {
    hoverTimeout = null;
    void onHoverFire(span, smiles);
  }, HOVER_DEBOUNCE_MS);
}

function onMouseout(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target?.closest?.('.novomcp-smiles')) return;
  if (hoverTimeout) { window.clearTimeout(hoverTimeout); hoverTimeout = null; }
  scheduleHide();
}

function onScroll(): void {
  // Reposition the open card if its anchor is still on screen
  if (hoverCard?.visible() && hoverTarget?.isConnected) {
    positionAtAnchor(hoverCard.host, hoverTarget);
  }
}

function scheduleHide(): void {
  if (hideTimeout) window.clearTimeout(hideTimeout);
  hideTimeout = window.setTimeout(() => {
    hideTimeout = null;
    hoverCard?.hide();
  }, HIDE_DELAY_MS);
}

async function onHoverFire(span: HTMLElement, smiles: string): Promise<void> {
  if (extensionContextLost) return;
  // Stage 1 — cache lookup only. Server work waits for click intent.
  const card = getHoverCard();
  card.setSmiles(smiles, span);

  const r = await safeSend<GetProfileResponse>({ type: 'GET_PROFILE', smiles, peek: true } as GetProfileRequest);
  if (extensionContextLost) { card.hide(); return; }
  if (r && r.ok && r.cached) {
    card.setProfile(smiles, r.data);
  } else {
    card.setLookupAffordance(smiles);
  }
}

function onClick(ev: MouseEvent): void {
  const target = ev.target as HTMLElement | null;
  if (!target) return;
  const span = target.closest?.('.novomcp-smiles') as HTMLElement | null;
  if (!span) return;
  const smiles = span.getAttribute(SMILES_ATTR);
  if (!smiles) return;
  // Click on underlined SMILES = explicit intent — fire the profile lookup
  ev.preventDefault();
  ev.stopPropagation();
  const card = getHoverCard();
  card.setSmiles(smiles, span);
  void requestProfile(smiles);
}

async function requestProfile(smiles: string): Promise<void> {
  if (extensionContextLost) return;
  const card = getHoverCard();

  // Per-tab concurrency cap of 5
  if (inFlight.has(smiles)) return; // already in flight
  if (inFlight.size >= PER_TAB_CONCURRENCY_CAP) {
    pendingQueue.push({
      smiles,
      intent: () => { void requestProfile(smiles); },
    });
    card.setLoading();
    return;
  }

  inFlight.add(smiles);
  card.setLoading();
  try {
    const r = await safeSend<GetProfileResponse>({ type: 'GET_PROFILE', smiles });
    if (extensionContextLost) { card.hide(); return; }
    if (r && r.ok) {
      card.setProfile(smiles, r.data);
    } else if (r && !r.ok) {
      card.setError(r.error || 'Lookup failed');
    } else {
      card.setError('No response from background worker');
    }
  } catch (e) {
    if (isContextInvalidated(e)) { onContextLost(); card.hide(); return; }
    card.setError(e instanceof Error ? e.message : 'Network error');
  } finally {
    inFlight.delete(smiles);
    const next = pendingQueue.shift();
    if (next) next.intent();
  }
}

async function openSidebarFor(smiles: string): Promise<void> {
  if (extensionContextLost) return;
  // Race: when the side panel isn't open yet, chrome.sidePanel.open() is
  // fire-and-forget; the panel needs ~50-100ms to mount its
  // chrome.runtime.onMessage listener. SMILES_SELECTED dispatched before
  // that lands silently drops, which made "Open in sidebar" feel like it
  // needed two clicks. Persist the pending SMILES so the side panel can
  // pick it up on mount regardless of message timing.
  await safeSend<unknown>({ type: 'OPEN_SIDE_PANEL', smiles } as OpenSidePanelRequest & { smiles: string });
  // Still fire the live message — once the panel is mounted on subsequent
  // clicks it's the cheaper path (no storage round-trip).
  await safeSend<unknown>({ type: 'SMILES_SELECTED', smiles } as SmilesSelectedEvent);
}
