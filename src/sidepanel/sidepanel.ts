/**
 * Side panel — listens for SMILES_SELECTED, fetches the profile via the
 * service worker, renders into tab panels (Profile / ADMET / Compliance /
 * Similar / Advanced), and exposes cross-surface deep-link CTAs.
 *
 * The Advanced tab is gated on a ncmcp_ Compute key. When present, four
 * sync compute calls (pKa, solubility, BDE, frontier orbitals) are
 * exposed as one-click buttons. Long-running compute (MD, FEP) does not
 * surface here — those are fire-and-continue and the user picks up the
 * result in the dashboard or in Claude/Workbench.
 */
import { send } from '../lib/messages';
import type {
  GetProfileRequest, GetProfileResponse, SmilesSelectedEvent,
  ComputeTool, InvokeComputeRequest, InvokeComputeResponse,
  SearchSimilarRequest, SearchSimilarResponse,
  FetchAdmetRequest, FetchAdmetResponse,
  FetchComplianceRequest, FetchComplianceResponse,
} from '../lib/messages';
import { normalize as normalizeAdmet, classificationColor, type AdmetCategory } from '../lib/admet';
import { auth } from '../lib/storage';
import { getCurrentFunnelId, dashboardUrl, claudeHandoffPrompt } from '../lib/funnel';
import type { ApiResponse, MoleculeProfile } from '../types';

type StateName = 'empty' | 'loading' | 'profile' | 'error';

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el as T;
};

const states: Record<StateName, HTMLElement> = {
  empty: $<HTMLElement>('state-empty'),
  loading: $<HTMLElement>('state-loading'),
  profile: $<HTMLElement>('state-profile'),
  error: $<HTMLElement>('state-error'),
};

let currentSmiles: string | null = null;

/**
 * Lazy-load caches keyed by SMILES. ADMET costs 20cr per call; deep
 * compliance costs 3cr — fire each at most once per molecule per panel
 * lifetime. Re-opening the tab on the same SMILES re-renders from cache.
 */
const admetCache = new Map<string, Record<AdmetCategory, ReturnType<typeof normalizeAdmet>[AdmetCategory]>>();
const complianceCache = new Map<string, Record<string, unknown>>();
const admetInFlight = new Set<string>();
const complianceInFlight = new Set<string>();

function show(state: StateName): void {
  for (const [name, el] of Object.entries(states)) {
    el.hidden = name !== state;
  }
}

// ─── Tab switching ────────────────────────────────────────────────────

function setupTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      const tabName = btn.dataset['tab'];
      if (!tabName || btn.disabled) return;
      switchTab(tabName);
    });
  });
}

function switchTab(name: string): void {
  document.querySelectorAll<HTMLElement>('.tab').forEach((b) => {
    b.setAttribute('aria-selected', b.dataset['tab'] === name ? 'true' : 'false');
  });
  document.querySelectorAll<HTMLElement>('.tab-panel').forEach((p) => {
    p.classList.toggle('active', p.id === `panel-${name}`);
  });
  // Lazy-load on first switch — full data, no meta-commentary, no
  // "aggregate scores only" disclaimer. Mirrors NovoWorkbench's pattern
  // (predict_admet on demand, check_compliance with default context).
  if (currentSmiles) {
    if (name === 'admet') void ensureAdmetLoaded(currentSmiles);
    else if (name === 'compliance') void ensureComplianceLoaded(currentSmiles);
  }
}

// ─── Inbound: SMILES selection from content script ────────────────────

chrome.runtime.onMessage.addListener((msg: unknown) => {
  if (!msg || typeof msg !== 'object') return;
  const m = msg as Record<string, unknown>;
  if (m['type'] === 'SMILES_SELECTED' && typeof m['smiles'] === 'string') {
    void load(m['smiles']);
  }
});

async function load(smiles: string): Promise<void> {
  if (!smiles) return;
  if (currentSmiles === smiles && !states.error.hidden) return;
  currentSmiles = smiles;

  $<HTMLElement>('loading-smiles').textContent = smiles;
  show('loading');
  resetAdvancedResults();
  resetSimilarResults();

  try {
    const r = await send<GetProfileResponse>({ type: 'GET_PROFILE', smiles } as GetProfileRequest);
    if (r.ok) {
      renderProfile(smiles, r.data);
    } else {
      renderError(smiles, r.error || 'Lookup failed');
    }
  } catch (e) {
    renderError(smiles, e instanceof Error ? e.message : 'Network error');
  }
}

// ─── Rendering ────────────────────────────────────────────────────────

function renderProfile(smiles: string, response: ApiResponse<MoleculeProfile>): void {
  const p = response.result;

  $<HTMLElement>('profile-smiles').textContent = smiles;

  // Two response paths return slightly different field names (e.g.
  // hbd_count vs hbd, rotatable_bond_count vs rotatable_bonds). Probe both.
  const props = (p.properties || {}) as Record<string, unknown>;
  const pick = (...keys: string[]): unknown => {
    for (const k of keys) if (props[k] != null) return props[k];
    return undefined;
  };
  const propRows: Array<[string, string]> = [];
  pushIfPresent(propRows, 'CID', props['cid'], formatInt);
  pushIfPresent(propRows, 'Formula', props['molecular_formula'], (v) => escapeText(String(v)));
  pushIfPresent(propRows, 'MW', props['molecular_weight'], (v) => `${formatNum(v)} g/mol`);
  pushIfPresent(propRows, 'LogP', props['logp'], formatNum);
  pushIfPresent(propRows, 'TPSA', props['tpsa'], formatNum);
  pushIfPresent(propRows, 'QED', props['qed'], formatNum);
  pushIfPresent(propRows, 'Drug-likeness', props['drug_likeness'], formatNum);
  pushIfPresent(propRows, 'Synth. accessibility', props['synthetic_accessibility'], formatNum);
  pushIfPresent(propRows, 'Complexity', props['complexity'], formatNum);
  pushIfPresent(propRows, 'Fsp³', props['fsp3'], formatNum);
  pushIfPresent(propRows, 'HBD', pick('hbd_count', 'hbd'), formatInt);
  pushIfPresent(propRows, 'HBA', pick('hba_count', 'hba'), formatInt);
  pushIfPresent(propRows, 'Rot bonds', pick('rotatable_bond_count', 'rotatable_bonds'), formatInt);
  pushIfPresent(propRows, 'Heavy atoms', props['heavy_atom_count'], formatInt);
  pushIfPresent(propRows, 'Aromatic rings', pick('aromatic_ring_count', 'aromatic_rings'), formatInt);
  pushIfPresent(propRows, 'Aromatic atoms', props['aromatic_atom_count'], formatInt);
  pushIfPresent(propRows, 'Lipinski violations', props['lipinski_violations'], formatInt);
  if (propRows.length === 0) propRows.push(['—', 'No properties returned']);
  renderGrid('profile-properties', propRows);

  // ADMET tab is now lazy-loaded via predict_admet directly — see
  // ensureAdmetLoaded(). The aggregate fields embedded in
  // get_molecule_profile.admet are not used; we always fetch the full
  // 40+ ML model panel on first ADMET tab open.
  resetAdmetTab();
  // If the user is already viewing ADMET when a new SMILES loads, kick
  // off the fetch immediately rather than waiting for a manual switch.
  if (document.getElementById('panel-admet')?.classList.contains('active')) {
    void ensureAdmetLoaded(smiles);
  }

  // Compliance tab is now lazy-loaded via check_compliance — see
  // ensureComplianceLoaded(). Same pattern as ADMET: fetch the deep
  // contextual evaluation on first tab open, render the full panel
  // (regulatory pathway, risk, recommendations, agent flags), no meta
  // commentary, no shrunken "aggregates-only" view.
  resetComplianceTab();
  if (document.getElementById('panel-compliance')?.classList.contains('active')) {
    void ensureComplianceLoaded(smiles);
  }

  // Footer meta
  const cost = response.usage?.credits ?? 0;
  const remaining = response.usage?.credits_remaining;
  const meta = $<HTMLElement>('profile-meta');
  meta.innerHTML = '';
  meta.appendChild(metaPill(p.in_database ? 'cached profile' : 'computed on demand'));
  meta.appendChild(metaPill(cost === 0 ? 'free lookup' : `${cost} credit${cost === 1 ? '' : 's'}`));
  if (typeof remaining === 'number') meta.appendChild(metaPill(`${Math.floor(remaining).toLocaleString()} credits left`));

  void renderAdvancedGate();
  void renderCrossSurface(smiles);

  show('profile');
}

function renderError(smiles: string, message: string): void {
  $<HTMLElement>('error-smiles').textContent = smiles;
  $<HTMLElement>('error-body').textContent = message;
  show('error');
}

// ─── ADMET tab — lazy fetch + full per-category render ───────────────

// A → D → M → E → T order, with the funnel letter explicit so the
// flow is obvious as a single vertical stack regardless of how many
// fields each section has.
const ADMET_CATEGORIES: Array<[AdmetCategory, string, string]> = [
  ['absorption', 'A', 'Absorption'],
  ['distribution', 'D', 'Distribution'],
  ['metabolism', 'M', 'Metabolism'],
  ['excretion', 'E', 'Excretion'],
  ['toxicity', 'T', 'Toxicity'],
];

function resetAdmetTab(): void {
  const el = $<HTMLElement>('profile-admet');
  el.innerHTML = '';
}

async function ensureAdmetLoaded(smiles: string): Promise<void> {
  if (admetCache.has(smiles)) {
    paintAdmet(admetCache.get(smiles)!);
    return;
  }
  if (admetInFlight.has(smiles)) return;
  admetInFlight.add(smiles);

  const el = $<HTMLElement>('profile-admet');
  el.innerHTML = `
    <div style="margin-top: 10px;">
      <div class="loading-skeleton"></div>
      <div class="loading-skeleton" style="width: 80%;"></div>
      <div class="loading-skeleton" style="width: 65%;"></div>
      <div class="loading-skeleton" style="width: 90%;"></div>
    </div>
  `;

  try {
    const r = await send<FetchAdmetResponse>({ type: 'FETCH_ADMET', smiles } as FetchAdmetRequest);
    if (smiles !== currentSmiles) return; // user moved on
    if (!r.ok) {
      el.innerHTML = `<p class="muted" style="font-size:12px;color:var(--error);">${escapeText(r.error || 'ADMET fetch failed')}</p>`;
      return;
    }
    const normalized = normalizeAdmet(r.data.result as Record<string, unknown>);
    admetCache.set(smiles, normalized);
    paintAdmet(normalized);
    void renderCrossSurface(smiles); // funnel may have advanced
  } catch (e) {
    el.innerHTML = `<p class="muted" style="font-size:12px;color:var(--error);">${escapeText(e instanceof Error ? e.message : 'Network error')}</p>`;
  } finally {
    admetInFlight.delete(smiles);
  }
}

function paintAdmet(normalized: Record<AdmetCategory, ReturnType<typeof normalizeAdmet>[AdmetCategory]>): void {
  const el = $<HTMLElement>('profile-admet');
  el.innerHTML = '';
  for (const [cat, letter, label] of ADMET_CATEGORIES) {
    const fields = normalized[cat];
    if (!fields || fields.length === 0) continue;

    // Inline category divider — letter chip + name on a hairline so the
    // ADMET funnel order (A → D → M → E → T) reads as a clear vertical
    // stack from the top of the tab to the bottom.
    const divider = document.createElement('div');
    divider.className = 'admet-divider';
    divider.innerHTML = `
      <span class="admet-divider-letter">${escapeText(letter)}</span>
      <span class="admet-divider-label">${escapeText(label)}</span>
      <span class="admet-divider-count">${fields.length}</span>
      <span class="admet-divider-line"></span>
    `;
    el.appendChild(divider);

    for (const f of fields) {
      const color = classificationColor(f.classification);
      const isProb = f.value >= 0 && f.value <= 1 && !f.unit;
      const valueDisplay = isProb
        ? `<span class="bar-track"><span class="bar-fill" style="width:${(f.value * 100).toFixed(0)}%;background:${color};"></span></span>
           <span class="bar-num" style="color:${color};">${f.value.toFixed(2)}</span>`
        : `<span class="bar-num bar-num-wide" style="color:${color};">${f.value.toFixed(f.unit ? 2 : 3)}${f.unit ? ` ${escapeText(f.unit)}` : ''}</span>`;

      const row = document.createElement('div');
      row.className = 'admet-field';
      // Stacked: title row on top (full width, full label visible),
      // metric row below (full width — bar takes whatever space the
      // value+badge don't).
      row.innerHTML = `
        <div class="admet-field-title">${escapeText(f.label)}</div>
        <div class="admet-field-metric">
          ${valueDisplay}
          <span class="admet-class" style="color:${color};border-color:color-mix(in srgb,${color} 35%,transparent);">${escapeText(f.classification)}</span>
        </div>
      `;
      el.appendChild(row);
    }
  }
}

// ─── Compliance tab — lazy fetch + full deep render ──────────────────

function resetComplianceTab(): void {
  const el = $<HTMLElement>('profile-compliance');
  el.innerHTML = '';
}

async function ensureComplianceLoaded(smiles: string): Promise<void> {
  if (complianceCache.has(smiles)) {
    paintCompliance(complianceCache.get(smiles)!);
    return;
  }
  if (complianceInFlight.has(smiles)) return;
  complianceInFlight.add(smiles);

  const el = $<HTMLElement>('profile-compliance');
  el.innerHTML = `
    <div style="margin-top: 10px;">
      <div class="loading-skeleton"></div>
      <div class="loading-skeleton" style="width: 70%;"></div>
      <div class="loading-skeleton" style="width: 85%;"></div>
    </div>
  `;

  try {
    const r = await send<FetchComplianceResponse>({ type: 'FETCH_COMPLIANCE', smiles } as FetchComplianceRequest);
    if (smiles !== currentSmiles) return;
    if (!r.ok) {
      el.innerHTML = `<p class="muted" style="font-size:12px;color:var(--error);">${escapeText(r.error || 'Compliance fetch failed')}</p>`;
      return;
    }
    const result = r.data.result as Record<string, unknown>;
    complianceCache.set(smiles, result);
    paintCompliance(result);
    void renderCrossSurface(smiles);
  } catch (e) {
    el.innerHTML = `<p class="muted" style="font-size:12px;color:var(--error);">${escapeText(e instanceof Error ? e.message : 'Network error')}</p>`;
  } finally {
    complianceInFlight.delete(smiles);
  }
}

function paintCompliance(result: Record<string, unknown>): void {
  const el = $<HTMLElement>('profile-compliance');
  el.innerHTML = '';

  const overall = String(result['overall_status'] ?? '');
  const baseCompliance = (result['base_compliance'] || {}) as Record<string, unknown>;
  const ctxCompliance = (result['context_compliance'] || {}) as Record<string, unknown>;

  // Headline status — prominent badge
  const verdictEl = document.createElement('div');
  verdictEl.className = 'compliance-verdict';
  const verdictClass = verdictBadgeClass(overall);
  verdictEl.innerHTML = `
    <span class="badge ${verdictClass}" style="font-size:11px;padding:3px 10px;">${escapeText(overall || 'unknown')}</span>
    <span style="font-size:11px;color:var(--text-muted);margin-left:8px;">pharmaceutical · US</span>
  `;
  el.appendChild(verdictEl);

  // Base compliance flags — what was checked
  const baseRows: Array<[string, string]> = [];
  const baseStatus = (baseCompliance['status'] as string) ?? null;
  if (baseStatus) baseRows.push(['Base status', `<span class="badge ${complianceBadgeClass(baseStatus)}">${escapeText(baseStatus)}</span>`]);
  pushFlag(baseRows, 'DEA controlled', baseCompliance['is_dea_controlled']);
  pushFlag(baseRows, 'FDA banned', baseCompliance['is_fda_banned']);
  pushFlag(baseRows, 'CWC scheduled', baseCompliance['is_cwc_scheduled']);
  pushFlag(baseRows, 'EPA PBT', baseCompliance['is_epa_pbt']);
  pushFlag(baseRows, 'EU REACH banned', baseCompliance['is_eu_reach_banned']);
  pushFlag(baseRows, 'Scaffold match', baseCompliance['is_scaffold_match']);
  pushFlag(baseRows, 'Whitelisted', baseCompliance['is_whitelisted'], 'ok');
  if (typeof baseCompliance['faves_flag_count'] === 'number' && (baseCompliance['faves_flag_count'] as number) > 0) {
    baseRows.push(['FAVES flags', `<span class="badge warn">${baseCompliance['faves_flag_count']}</span>`]);
  }
  if (baseRows.length > 0) {
    appendSection(el, 'Regulatory flags', () => {
      const wrap = document.createElement('dl');
      wrap.className = 'props-grid';
      for (const [label, value] of baseRows) {
        const dt = document.createElement('dt'); dt.textContent = label;
        const dd = document.createElement('dd'); dd.innerHTML = value;
        wrap.appendChild(dt); wrap.appendChild(dd);
      }
      return wrap;
    });
  }

  // Risk assessment
  const risk = result['risk_assessment'] as Record<string, unknown> | undefined;
  if (risk && Object.keys(risk).length > 0) {
    appendSection(el, 'Risk assessment', () => renderKvBlock(risk));
  }

  // Regulatory pathway
  const pathway = result['regulatory_pathway'] as Record<string, unknown> | string | undefined;
  if (pathway) {
    appendSection(el, 'Regulatory pathway', () => {
      const block = document.createElement('div');
      block.className = 'compliance-block';
      if (typeof pathway === 'string') {
        block.textContent = pathway;
      } else {
        block.appendChild(renderKvBlock(pathway));
      }
      return block;
    });
  }

  // Recommendations
  const recs = result['recommendations'];
  if (Array.isArray(recs) && recs.length > 0) {
    appendSection(el, 'Recommendations', () => {
      const ul = document.createElement('ul');
      ul.className = 'compliance-recs';
      for (const r of recs.slice(0, 8)) {
        const li = document.createElement('li');
        li.textContent = String(r);
        ul.appendChild(li);
      }
      return ul;
    });
  }

  // Context-compliance dimensions / agents (if returned)
  const dims = ctxCompliance['dimensions'] as Record<string, unknown> | undefined;
  if (dims && Object.keys(dims).length > 0) {
    appendSection(el, 'FAVES dimensions', () => {
      const wrap = document.createElement('div');
      wrap.className = 'faves-dims';
      for (const [name, dim] of Object.entries(dims)) {
        const status = String((dim as Record<string, unknown>)?.['status'] ?? '');
        const cls = status === 'PASS' ? 'ok' : status === 'WARN' ? 'warn' : status === 'FAIL' ? 'err' : '';
        const dimEl = document.createElement('div');
        dimEl.className = 'faves-dim';
        dimEl.innerHTML = `
          <div class="faves-name">${escapeText(humanizeKey(name))}</div>
          <span class="badge ${cls}">${escapeText(status || '—')}</span>
        `;
        wrap.appendChild(dimEl);
      }
      return wrap;
    });
  }
}

function appendSection(parent: HTMLElement, title: string, builder: () => HTMLElement): void {
  const heading = document.createElement('h4');
  heading.textContent = title;
  heading.style.cssText = 'margin: 14px 0 6px 0; font-size: 11px; letter-spacing: 0.05em; text-transform: uppercase; color: var(--text-muted); font-weight: 500;';
  parent.appendChild(heading);
  parent.appendChild(builder());
}

function renderKvBlock(obj: Record<string, unknown>): HTMLElement {
  const dl = document.createElement('dl');
  dl.className = 'props-grid';
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === '') continue;
    if (Array.isArray(v) && v.length === 0) continue;
    const dt = document.createElement('dt'); dt.textContent = humanizeKey(k);
    const dd = document.createElement('dd');
    dd.appendChild(renderValue(v));
    dl.appendChild(dt); dl.appendChild(dd);
  }
  return dl;
}

/**
 * Recursive value renderer. The compliance / risk_assessment / pathway
 * blocks ship arbitrarily nested data — risk_factors is typically an
 * array of {category, severity, description} objects. Naive
 * Array.map(String) → "[object Object]"; pretty-print into a structured
 * sub-block so the user sees the actual fields.
 */
function renderValue(v: unknown): Node {
  if (v == null || v === '') return document.createTextNode('—');
  if (typeof v === 'boolean') {
    const span = document.createElement('span');
    span.className = `badge ${v ? 'warn' : ''}`;
    span.textContent = v ? 'yes' : 'no';
    return span;
  }
  if (typeof v === 'number') return document.createTextNode(formatNum(v));
  if (typeof v === 'string') return document.createTextNode(v);
  if (Array.isArray(v)) {
    if (v.length === 0) return document.createTextNode('—');
    // Array of primitives — render as a comma-joined string
    if (v.every((x) => typeof x !== 'object' || x === null)) {
      return document.createTextNode(v.map((x) => String(x)).join(', '));
    }
    // Array of objects — stack each as a nested kv block
    const wrap = document.createElement('div');
    wrap.className = 'kv-array';
    for (const item of v.slice(0, 8)) {
      if (item && typeof item === 'object') {
        const card = document.createElement('div');
        card.className = 'kv-array-item';
        card.appendChild(renderKvBlock(item as Record<string, unknown>));
        wrap.appendChild(card);
      } else {
        const li = document.createElement('div');
        li.textContent = String(item);
        wrap.appendChild(li);
      }
    }
    return wrap;
  }
  if (typeof v === 'object') {
    return renderKvBlock(v as Record<string, unknown>);
  }
  return document.createTextNode(String(v));
}

function pushFlag(rows: Array<[string, string]>, label: string, value: unknown, trueClass: 'ok' | 'warn' | 'err' = 'warn'): void {
  if (value === true) rows.push([label, `<span class="badge ${trueClass}">yes</span>`]);
  else if (value === false) rows.push([label, '<span class="badge">no</span>']);
}

function verdictBadgeClass(s: string): string {
  const u = s.toUpperCase();
  if (u === 'PROCEED' || u === 'PASS' || u === 'CLEAR') return 'ok';
  if (u === 'CAUTION' || u === 'CONDITIONAL' || u === 'WARN' || u === 'REVIEW_REQUIRED') return 'warn';
  if (u === 'STOP' || u === 'BLOCKED' || u === 'FAIL' || u === 'REJECTED') return 'err';
  return '';
}

/** Append a key/value grid to a parent — used by renderAdmetTab subsections. */
function appendGrid(parent: HTMLElement, rows: Array<[string, string]>): void {
  const dl = document.createElement('dl');
  dl.className = 'props-grid';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.innerHTML = value;
    dl.appendChild(dt);
    dl.appendChild(dd);
  }
  parent.appendChild(dl);
}

function renderGrid(id: string, rows: Array<[string, string]>): void {
  const el = $<HTMLElement>(id);
  el.innerHTML = '';
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.innerHTML = value;
    el.appendChild(dt);
    el.appendChild(dd);
  }
}

function metaPill(text: string): HTMLElement {
  const span = document.createElement('span');
  span.className = 'badge';
  span.textContent = text;
  return span;
}

// ─── Advanced tab — Compute calls ─────────────────────────────────────

async function renderAdvancedGate(): Promise<void> {
  const computeKey = await auth.getComputeKey();
  const lock = $<HTMLElement>('advanced-lock');
  const locked = $<HTMLElement>('advanced-locked');
  const tools = $<HTMLElement>('advanced-tools');
  if (computeKey) {
    lock.hidden = true;
    locked.hidden = true;
    tools.hidden = false;
  } else {
    lock.hidden = false;
    locked.hidden = false;
    tools.hidden = true;
  }
}

function setupAdvancedHandlers(): void {
  document.querySelectorAll<HTMLElement>('.compute-card').forEach((card) => {
    const tool = card.dataset['tool'] as ComputeTool;
    const btn = card.querySelector<HTMLButtonElement>('button[data-action="run"]');
    if (!btn) return;
    btn.addEventListener('click', () => { void runComputeTool(tool, card); });
  });
}

function resetAdvancedResults(): void {
  document.querySelectorAll<HTMLElement>('.compute-card').forEach((card) => {
    const tool = card.dataset['tool'] as ComputeTool;
    const body = card.querySelector<HTMLElement>('[data-result]');
    if (!body) return;
    body.innerHTML = defaultHint(tool);
    const btn = card.querySelector<HTMLButtonElement>('button[data-action="run"]');
    if (btn) { btn.disabled = false; btn.textContent = 'Run'; }
  });
}

/**
 * Translate raw server errors into something a chemist can act on.
 *
 *   - Strip the wrapping "Tool failed (NNN): {json}" envelope.
 *   - Pull `detail` from the inner JSON when present.
 *   - Truncate any embedded SMILES (the QM service likes echoing the
 *     full input back which bloats the message).
 *   - Redact server-config leaks (e.g. "check NOVOMCP_QM_URL configuration"
 *     — that's an ops hint, not a user hint).
 *   - Map HTTP class to a tone: 4xx = molecule issue, 5xx = service hiccup.
 */
const TOOL_LABEL: Record<ComputeTool, string> = {
  predict_pka: 'pKa',
  predict_solubility: 'Solubility',
  predict_bde: 'BDE',
  predict_frontier_orbitals: 'Frontier orbitals',
};

function friendlyComputeError(tool: ComputeTool, raw: string): string {
  const label = TOOL_LABEL[tool] ?? 'Calculation';
  const codeMatch = raw.match(/\((\d{3})\)/);
  const status = codeMatch ? Number(codeMatch[1]) : null;

  // Try to extract an inner JSON `detail` field.
  let detail = '';
  const jsonStart = raw.indexOf('{');
  if (jsonStart >= 0) {
    try {
      const parsed = JSON.parse(raw.slice(jsonStart));
      if (parsed && typeof parsed === 'object' && 'detail' in parsed) {
        detail = String((parsed as Record<string, unknown>)['detail'] ?? '');
      }
    } catch { /* not JSON — leave detail blank */ }
  }

  if (detail) {
    // Drop server-config leaks (everything after "— check XXX_URL …")
    detail = detail.replace(/[—-]\s*check\s+\w+_URL\s+configuration[\s\S]*$/i, '').trim();
    // Truncate echoed SMILES so the message stays readable
    detail = detail.replace(/for:\s*[A-Za-z0-9@+\-\[\]()=#$/\\.]{20,}/, 'for this molecule');
    if (detail) return detail;
  }

  // Tone-of-message based on HTTP class
  if (status && status >= 500) return `${label} service is temporarily unavailable. Try again in a moment.`;
  if (status === 422 || status === 400) return `${label} couldn't process this molecule. Try a different scaffold.`;
  if (status === 401) return `${label} requires a valid Compute (ncmcp_) key. Add or update it from the popup.`;
  if (status === 402) return `${label} needs more credits. Upgrade or wait for the next billing cycle.`;
  if (status === 429) return `${label} is rate-limited right now. Try again shortly.`;

  // Fallback: trim the raw to something readable
  const trimmed = raw.length > 140 ? raw.slice(0, 140) + '…' : raw;
  return `${label}: ${trimmed}`;
}

function defaultHint(tool: ComputeTool): string {
  switch (tool) {
    case 'predict_pka': return 'Click run to predict ionization sites and pKa values.';
    case 'predict_solubility': return 'Aqueous solubility (logS) with class label.';
    case 'predict_bde': return 'BDE per bond — flag the weakest links.';
    case 'predict_frontier_orbitals': return 'HOMO, LUMO, and gap (eV).';
  }
}

async function runComputeTool(tool: ComputeTool, card: HTMLElement): Promise<void> {
  if (!currentSmiles) return;
  const btn = card.querySelector<HTMLButtonElement>('button[data-action="run"]')!;
  const body = card.querySelector<HTMLElement>('[data-result]')!;
  btn.disabled = true;
  btn.textContent = 'Running…';
  body.innerHTML = '<span class="muted">Running</span>';

  try {
    const r = await send<InvokeComputeResponse>({ type: 'INVOKE_COMPUTE', tool, smiles: currentSmiles } as InvokeComputeRequest);
    if (r.ok) {
      body.innerHTML = renderComputeResult(tool, r.data.result);
      // refresh footer CTAs since funnel_id may have advanced
      if (currentSmiles) void renderCrossSurface(currentSmiles);
    } else {
      body.innerHTML = `<span class="muted" style="color: var(--error);">${escapeText(friendlyComputeError(tool, r.error || 'failed'))}</span>`;
    }
  } catch (e) {
    body.innerHTML = `<span class="muted" style="color: var(--error);">${escapeText(friendlyComputeError(tool, e instanceof Error ? e.message : 'failed'))}</span>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run';
  }
}

function renderComputeResult(tool: ComputeTool, data: unknown): string {
  const d = (data || {}) as Record<string, unknown>;
  switch (tool) {
    case 'predict_pka': {
      // Server returns: pka_values: number[], ionizable_groups: string[],
      // method, confidence, interpretation. (tools.py:_execute_predict_pka)
      const values = (d['pka_values'] as unknown[]) || [];
      const groups = (d['ionizable_groups'] as unknown[]) || [];
      const interp = d['interpretation'] as string | undefined;
      if (values.length === 0 || (groups.length === 1 && groups[0] === 'none_detected')) {
        return `<span class="muted">No ionizable groups detected. Molecule expected to be neutral across physiological pH range.</span>`;
      }
      const rows = values.slice(0, 6).map((v, i) => {
        const site = groups[i] ?? `site ${i + 1}`;
        return `<dt>${escapeText(String(site))}</dt><dd>pKa ${formatNum(v)}</dd>`;
      }).join('');
      const interpRow = interp ? `<div class="hint" style="margin-top:6px;">${escapeText(interp)}</div>` : '';
      return `<dl class="props-grid">${rows}</dl>${interpRow}`;
    }
    case 'predict_solubility': {
      // Server returns: logS, solubility_mg_ml, temperature, category, method, confidence
      const logS = d['logS'];
      const mgMl = d['solubility_mg_ml'];
      const category = d['category'];
      const temp = d['temperature'];
      const rows: string[] = [];
      if (typeof logS === 'number') rows.push(`<dt>logS</dt><dd>${formatNum(logS)}</dd>`);
      if (typeof mgMl === 'number') rows.push(`<dt>Solubility</dt><dd>${formatNum(mgMl)} mg/mL</dd>`);
      if (category) rows.push(`<dt>Class</dt><dd>${escapeText(String(category))}</dd>`);
      if (temp) rows.push(`<dt>Temperature</dt><dd>${escapeText(String(temp))}</dd>`);
      if (rows.length === 0) return '<span class="muted">No solubility data returned.</span>';
      return `<dl class="props-grid">${rows.join('')}</dl>`;
    }
    case 'predict_bde': {
      // Server returns: bonds, weakest_bond, interpretation, bond_count
      const weakest = d['weakest_bond'] as Record<string, unknown> | null | undefined;
      const interp = d['interpretation'] as string | undefined;
      const bondCount = d['bond_count'];
      const rows: string[] = [];
      if (weakest && weakest['atoms'] != null) {
        rows.push(`<dt>Weakest bond</dt><dd>${escapeText(String(weakest['atoms']))}</dd>`);
        if (typeof weakest['bde_kcal_mol'] === 'number') {
          rows.push(`<dt>BDE</dt><dd>${formatNum(weakest['bde_kcal_mol'])} kcal/mol</dd>`);
        }
      }
      if (typeof bondCount === 'number') rows.push(`<dt>Bonds analyzed</dt><dd>${bondCount}</dd>`);
      if (rows.length === 0) {
        const bonds = (d['bonds'] as Array<Record<string, unknown>>) || [];
        if (bonds.length === 0) return '<span class="muted">No BDE data returned.</span>';
        const top = bonds.slice().sort((a, b) => Number(a['bde_kcal_mol']) - Number(b['bde_kcal_mol'])).slice(0, 3);
        rows.push(...top.map((b) => `<dt>${escapeText(String(b['atoms'] ?? '—'))}</dt><dd>${formatNum(b['bde_kcal_mol'])} kcal/mol</dd>`));
      }
      const interpRow = interp ? `<div class="hint" style="margin-top:6px;">${escapeText(interp)}</div>` : '';
      return `<dl class="props-grid">${rows.join('')}</dl>${interpRow}`;
    }
    case 'predict_frontier_orbitals': {
      // Server passes through whatever novomcp-properties returns; common
      // fields are homo / lumo / gap (eV), with optional dipole and
      // electron affinity. Render every recognized numeric field.
      const candidates: Array<[string, string]> = [
        ['HOMO', 'homo'], ['HOMO', 'homo_eV'],
        ['LUMO', 'lumo'], ['LUMO', 'lumo_eV'],
        ['Gap', 'gap'], ['Gap', 'gap_eV'], ['Gap', 'homo_lumo_gap'],
        ['Dipole', 'dipole'], ['Dipole', 'dipole_moment'],
        ['IP', 'ionization_potential'],
        ['EA', 'electron_affinity'],
      ];
      const seen = new Set<string>();
      const rows: string[] = [];
      for (const [label, key] of candidates) {
        if (seen.has(label)) continue;
        const v = d[key];
        if (typeof v === 'number') {
          rows.push(`<dt>${label}</dt><dd>${formatNum(v)} eV</dd>`);
          seen.add(label);
        }
      }
      if (rows.length === 0) {
        // Last-resort: show any numeric top-level field
        for (const [k, v] of Object.entries(d)) {
          if (k === 'smiles' || k === 'method' || k === 'confidence' || k === 'units') continue;
          if (typeof v === 'number') rows.push(`<dt>${humanizeKey(k)}</dt><dd>${formatNum(v)}</dd>`);
        }
      }
      if (rows.length === 0) return '<span class="muted">No orbital data returned.</span>';
      return `<dl class="props-grid">${rows.join('')}</dl>`;
    }
  }
}

// ─── Similar tab — chemical-space neighbors ──────────────────────────

let similarThreshold = 0.7;

function setupSimilarHandlers(): void {
  const btn = document.getElementById('similar-run') as HTMLButtonElement | null;
  btn?.addEventListener('click', () => { void runSimilar(); });

  document.querySelectorAll<HTMLButtonElement>('.similar-thresh').forEach((b) => {
    b.addEventListener('click', () => {
      const v = Number(b.dataset['similarThreshold']);
      if (!isFinite(v)) return;
      similarThreshold = v;
      document.querySelectorAll<HTMLElement>('.similar-thresh').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
}

function resetSimilarResults(): void {
  const out = document.getElementById('similar-results');
  if (out) out.innerHTML = '';
  const btn = document.getElementById('similar-run') as HTMLButtonElement | null;
  if (btn) { btn.disabled = false; btn.textContent = 'Search neighbors'; }
}

async function runSimilar(): Promise<void> {
  if (!currentSmiles) return;
  const out = document.getElementById('similar-results');
  const btn = document.getElementById('similar-run') as HTMLButtonElement | null;
  if (!out || !btn) return;

  btn.disabled = true;
  btn.textContent = 'Searching…';
  out.innerHTML = '<p class="muted" style="font-size:12px;">Searching for neighbors…</p>';

  try {
    const r = await send<SearchSimilarResponse>({
      type: 'SEARCH_SIMILAR', smiles: currentSmiles, top_k: 10, min_similarity: similarThreshold,
    } as SearchSimilarRequest);
    if (!r.ok) {
      out.innerHTML = `<p class="muted" style="color: var(--error); font-size: 12px;">${escapeText(r.error || 'Search failed')}</p>`;
      return;
    }
    out.innerHTML = renderSimilarResults(r.data.result);
    void renderCrossSurface(currentSmiles); // funnel may have advanced
  } catch (e) {
    out.innerHTML = `<p class="muted" style="color: var(--error); font-size: 12px;">${escapeText(e instanceof Error ? e.message : 'Network error')}</p>`;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Re-run';
  }
}

function renderSimilarResults(data: unknown): string {
  // Server response shape varies; probe common keys before falling back to
  // a flat array. The API returns either { results: [...] } or
  // { similar_molecules: [...] }; older shapes use { matches: [...] }.
  const d = (data || {}) as Record<string, unknown>;
  const rows: Array<Record<string, unknown>> =
    (Array.isArray(d['results']) ? d['results'] :
     Array.isArray(d['similar_molecules']) ? d['similar_molecules'] :
     Array.isArray(d['matches']) ? d['matches'] :
     Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []) as Array<Record<string, unknown>>;

  if (rows.length === 0) {
    return `<p class="muted" style="font-size:12px;">No neighbors at threshold ${similarThreshold.toFixed(1)}. Try a lower threshold above, or pick a more populous scaffold.</p>`;
  }

  const items = rows.slice(0, 20).map((row) => {
    const smiles = String(row['smiles'] ?? '');
    const sim = (row['similarity'] ?? row['tanimoto'] ?? row['score']) as number | undefined;
    const cid = row['cid'];
    const mw = row['molecular_weight'];
    const qed = row['qed'];
    const logp = row['logp'] ?? row['xlogp'];
    const status = (row['compliance_status'] ?? row['status']) as string | undefined;
    const cidLink = cid != null ? `<a href="https://pubchem.ncbi.nlm.nih.gov/compound/${escapeText(String(cid))}" target="_blank" rel="noopener" class="cid">CID ${escapeText(String(cid))}</a>` : '';
    const simLabel = typeof sim === 'number' ? `<span class="badge">${(sim * 100).toFixed(0)}% Tc</span>` : '';
    const statusBadge = status ? `<span class="badge ${complianceBadgeClass(status)}">${escapeText(status)}</span>` : '';
    const meta = [
      typeof mw === 'number' ? `MW ${formatNum(mw)}` : '',
      typeof logp === 'number' ? `LogP ${formatNum(logp)}` : '',
      typeof qed === 'number' ? `QED ${formatNum(qed)}` : '',
    ].filter(Boolean).join(' · ');
    return `
      <div class="similar-row" data-smiles="${escapeText(smiles)}">
        <div class="similar-head">
          ${simLabel}${statusBadge}${cidLink}
        </div>
        <div class="similar-smiles">${escapeText(smiles)}</div>
        ${meta ? `<div class="similar-meta">${meta}</div>` : ''}
      </div>
    `;
  }).join('');

  // Click any neighbor row → load its profile in this same panel
  setTimeout(() => {
    document.querySelectorAll<HTMLElement>('.similar-row').forEach((el) => {
      el.addEventListener('click', () => {
        const s = el.dataset['smiles'];
        if (s) { void load(s); switchTab('profile'); }
      });
    });
  }, 0);

  return items;
}

// ─── Cross-surface CTAs ───────────────────────────────────────────────

async function renderCrossSurface(smiles: string): Promise<void> {
  const funnelId = await getCurrentFunnelId();
  const wrap = $<HTMLElement>('cross-surface');
  if (!funnelId) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const dashLink = $<HTMLAnchorElement>('cta-dashboard');
  dashLink.href = dashboardUrl(funnelId);

  const aiBtn = $<HTMLButtonElement>('cta-ai-assistant');
  aiBtn.onclick = async () => {
    try {
      const text = claudeHandoffPrompt(funnelId, smiles);
      await navigator.clipboard.writeText(text);
      // Visible feedback — change the button label and styling for 2s.
      const label = $<HTMLElement>('cta-ai-label');
      const arrow = $<HTMLElement>('cta-ai-arrow');
      const originalLabel = label.textContent;
      const originalArrow = arrow.textContent;
      label.textContent = 'Copied — paste into your AI assistant';
      arrow.textContent = '✓';
      aiBtn.classList.add('copied');
      window.setTimeout(() => {
        label.textContent = originalLabel;
        arrow.textContent = originalArrow;
        aiBtn.classList.remove('copied');
      }, 2000);
    } catch {
      const label = $<HTMLElement>('cta-ai-label');
      const original = label.textContent;
      label.textContent = 'Clipboard blocked — paste manually from below';
      window.setTimeout(() => { label.textContent = original; }, 2000);
    }
  };

  $<HTMLElement>('cta-funnel-id').textContent = funnelId;
}

// ─── Utilities ────────────────────────────────────────────────────────

function formatNum(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return v.toFixed(2);
}

function formatInt(v: unknown): string {
  if (typeof v !== 'number' || !isFinite(v)) return '—';
  return Math.round(v).toString();
}

function pushIfPresent(
  rows: Array<[string, string]>,
  label: string,
  value: unknown,
  fmt: (v: unknown) => string,
): void {
  if (value == null || value === '') return;
  if (typeof value === 'number' && !isFinite(value)) return;
  const formatted = fmt(value);
  if (formatted === '—' || formatted === '') return;
  rows.push([label, formatted]);
}

function pushBoolFlag(
  rows: Array<[string, string]>,
  label: string,
  value: unknown,
  trueClass: 'ok' | 'warn' | 'err' = 'warn',
): void {
  if (value !== true && value !== false) return;
  if (value === false) return; // skip "no" flags to keep the tab focused
  rows.push([label, `<span class="badge ${trueClass}">yes</span>`]);
}

function humanizeKey(k: string): string {
  return k
    .replace(/_/g, ' ')
    .replace(/\bcyp\b/gi, 'CYP')
    .replace(/\bbbb\b/gi, 'BBB')
    .replace(/\bherg\b/gi, 'hERG')
    .replace(/\bdili\b/gi, 'DILI')
    .replace(/\bhia\b/gi, 'HIA')
    .replace(/\bpgp\b/gi, 'P-gp');
}

function formatAdmetValue(v: unknown): string {
  if (typeof v === 'boolean') return v ? `<span class="badge warn">yes</span>` : `<span class="badge">no</span>`;
  if (typeof v === 'number') return formatNum(v);
  if (v == null) return '—';
  return escapeText(String(v));
}

function complianceBadgeClass(status: string): string {
  const s = status.toLowerCase();
  if (s === 'clear' || s === 'ok' || s === 'pass') return 'ok';
  if (s === 'controlled' || s === 'flagged' || s === 'warn') return 'warn';
  if (s === 'blocked' || s === 'fail' || s === 'rejected') return 'err';
  return '';
}

function escapeText(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─── Boot ─────────────────────────────────────────────────────────────

setupTabs();
setupAdvancedHandlers();
setupSimilarHandlers();
show('empty');

const urlSmiles = new URLSearchParams(window.location.search).get('smiles');
if (urlSmiles) void load(urlSmiles);

// Pick up any pending SMILES the content script stashed via OPEN_SIDE_PANEL.
// Solves the "click twice" race: when the panel opens for the first time,
// the content script's SMILES_SELECTED message can fire before this file's
// onMessage listener is registered. The pending SMILES is the durable
// fallback — read once, clear, load.
(async () => {
  const session = (chrome.storage as unknown as { session?: chrome.storage.StorageArea }).session
    ?? chrome.storage.local;
  try {
    const r = await session.get('novo.pendingSmiles');
    const pending = r['novo.pendingSmiles'] as string | undefined;
    if (pending) {
      await session.remove('novo.pendingSmiles');
      void load(pending);
    }
  } catch { /* noop */ }
})();

document.documentElement.dataset['novomcp'] = 'sidepanel-ready';
