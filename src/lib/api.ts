/**
 * Thin HTTPS client for api.novomcp.com.
 *
 * Every request carries:
 *   - Authorization: Bearer <nmcp_ or ncmcp_ key>
 *   - X-Novo-Surface: chrome-ext-v1   → namespaces funnel_id + persists in audit row
 *   - User-Agent: NovoMCP-ChromeExt/<v>  → secondary diagnostic signal
 *
 * Error handling follows the structured-error contract:
 *   - Successful tools: 200 with { result, usage }
 *   - Failed tools: 4xx with detail = { error, error_code?, ...tool-specific fields }
 *   - 402 credits_exhausted: detail = { error, message, upgrade_url, packs }
 */
import { getApiBase, SURFACE_TAG, UA_PREFIX } from './constants';
import { auth } from './storage';
import { recordFunnelId } from './funnel';
import type {
  ApiResponse, ApiError, MoleculeProfile, NovoUser,
  PkaResult, SolubilityResult, BdeResult, FrontierOrbitalsResult,
} from '../types';

export class ApiError$ extends Error {
  constructor(
    public readonly status: number,
    public readonly body: ApiError,
  ) {
    super(body.error || body.message || `HTTP ${status}`);
    this.name = 'ApiError';
  }
  get errorCode(): string | undefined { return this.body.error_code; }
  get isCreditsExhausted(): boolean { return this.errorCode === 'credits_exhausted'; }
  get isUnauthorized(): boolean { return this.status === 401; }
}

async function request<T>(
  path: string,
  init: RequestInit & { useComputeKey?: boolean } = {},
): Promise<T> {
  const key = init.useComputeKey
    ? await auth.getComputeKey()
    : await auth.getNovoKey();
  if (!key) throw new ApiError$(401, { error: 'no_api_key' });

  const headers = new Headers(init.headers);
  headers.set('Authorization', `Bearer ${key}`);
  headers.set('X-Novo-Surface', SURFACE_TAG);
  // Note: Chrome strips User-Agent for fetch() in some contexts; UA_PREFIX
  // is also encoded into the request via a custom header for analytics.
  headers.set('X-Novo-Client', UA_PREFIX);
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const base = await getApiBase();
  const response = await fetch(`${base}${path}`, { ...init, headers });

  if (!response.ok) {
    let body: ApiError = { error: `HTTP ${response.status}` };
    try {
      const json = await response.json() as { detail?: unknown } | Record<string, unknown>;
      if ('detail' in json && json.detail && typeof json.detail === 'object') {
        body = json.detail as ApiError;
      } else if (typeof json === 'object' && 'error' in json) {
        body = json as ApiError;
      }
    } catch { /* keep synthetic body */ }
    throw new ApiError$(response.status, body);
  }

  return response.json() as Promise<T>;
}

/** Validate the saved key by hitting /mcp/usage. Returns the user or throws. */
export async function validateKey(): Promise<NovoUser> {
  return request<NovoUser>('/mcp/usage', { method: 'GET' });
}

/** Validate an arbitrary key without persisting it. Used by onboarding. */
export async function probeKey(key: string): Promise<NovoUser> {
  const base = await getApiBase();
  const response = await fetch(`${base}/mcp/usage`, {
    method: 'GET',
    headers: {
      'Authorization': `Bearer ${key}`,
      'X-Novo-Surface': SURFACE_TAG,
      'X-Novo-Client': UA_PREFIX,
    },
  });
  if (!response.ok) {
    let body: ApiError = { error: `HTTP ${response.status}` };
    try { body = await response.json() as ApiError; } catch {}
    throw new ApiError$(response.status, body);
  }
  return response.json() as Promise<NovoUser>;
}

/**
 * Generic tool invocation. The server unwraps `body.arguments` — sending
 * fields at the top level returns "Missing required parameter: <field>".
 */
async function invokeTool<T>(
  toolName: string,
  args: Record<string, unknown>,
  opts: { useComputeKey?: boolean } = {},
): Promise<ApiResponse<T>> {
  const response = await request<ApiResponse<T>>(`/mcp/tools/${toolName}`, {
    method: 'POST',
    body: JSON.stringify({ arguments: args }),
    useComputeKey: opts.useComputeKey,
  });
  // Capture funnel_id from every successful tool call so the side panel's
  // cross-surface CTAs can build deep-links without a separate round-trip.
  await recordFunnelId(response);
  return response;
}

export async function getMoleculeProfile(smiles: string): Promise<ApiResponse<MoleculeProfile>> {
  return invokeTool<MoleculeProfile>('get_molecule_profile', { smiles });
}

export interface SimilarMoleculeRow {
  smiles?: string;
  cid?: number | string;
  similarity?: number;
  tanimoto?: number;
  score?: number;
  molecular_weight?: number;
  qed?: number;
  logp?: number;
  xlogp?: number;
  compliance_status?: string;
  status?: string;
  [k: string]: unknown;
}
export interface SimilarResults {
  results?: SimilarMoleculeRow[];
  similar_molecules?: SimilarMoleculeRow[];
  matches?: SimilarMoleculeRow[];
  query_smiles?: string;
  count?: number;
  threshold?: number;
  [k: string]: unknown;
}

/**
 * Chemical-space neighbor search. Returns { results: [...] } — the
 * defensive renderer handles variant response shapes from the backend.
 */
export async function searchSimilar(
  smiles: string,
  opts: { top_k?: number; min_similarity?: number; exclude_controlled?: boolean } = {},
): Promise<ApiResponse<SimilarResults>> {
  const args: Record<string, unknown> = { smiles };
  if (opts.top_k != null) args['top_k'] = opts.top_k;
  if (opts.min_similarity != null) args['min_similarity'] = opts.min_similarity;
  // property_filters bag is post-search; leave exclude_controlled off by
  // default since users on PubChem expect the full neighbor list.
  if (opts.exclude_controlled === true) {
    args['property_filters'] = { exclude_controlled: true };
  }
  return invokeTool<SimilarResults>('vector_search', args);
}

// ─── Compute-tier tools (require ncmcp_ key) ─────────────────────────
// Hardcoded allowlist for v1. Sharpening 1: dynamic /mcp/tool-search lifts
// to v1.1 once we have a feel for what the surface expansion warrants.

/**
 * Full ADMET prediction (40+ ML models, ~20 credits, FREE tier).
 * Mirrors NovoWorkbench's pattern — call directly when the rich
 * per-category panel is needed; the embedded call inside
 * get_molecule_profile only fires for novel SMILES.
 */
export async function predictAdmet(smiles: string): Promise<ApiResponse<Record<string, unknown>>> {
  return invokeTool<Record<string, unknown>>('predict_admet', { smiles });
}

/**
 * Deep compliance / FAVES contextual evaluation. The MCP tool
 * `check_compliance` requires `intended_use` + `jurisdiction`; we use the
 * NovoWorkbench defaults (pharmaceutical / US) which match the most
 * common research-context lens. Returns base_compliance + context_compliance
 * + recommendations + regulatory_pathway + risk_assessment.
 */
export async function checkComplianceDeep(smiles: string): Promise<ApiResponse<Record<string, unknown>>> {
  return invokeTool<Record<string, unknown>>('check_compliance', {
    smiles,
    context: { intended_use: 'pharmaceutical', jurisdiction: 'US' },
  });
}

export async function predictPka(smiles: string): Promise<ApiResponse<PkaResult>> {
  return invokeTool<PkaResult>('predict_pka', { smiles }, { useComputeKey: true });
}

export async function predictSolubility(smiles: string): Promise<ApiResponse<SolubilityResult>> {
  return invokeTool<SolubilityResult>('predict_solubility', { smiles }, { useComputeKey: true });
}

export async function predictBde(smiles: string): Promise<ApiResponse<BdeResult>> {
  return invokeTool<BdeResult>('predict_bde', { smiles }, { useComputeKey: true });
}

export async function predictFrontierOrbitals(smiles: string): Promise<ApiResponse<FrontierOrbitalsResult>> {
  return invokeTool<FrontierOrbitalsResult>('predict_frontier_orbitals', { smiles }, { useComputeKey: true });
}
