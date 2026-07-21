export interface NovoUser {
  user_id: string;
  email: string;
  org: string | null;
  tier: string;
  credits_available?: number;
}

export interface MoleculeProfile {
  smiles: string;
  source: 'enriched_database' | 'computed+admet';
  in_database: boolean;
  properties: Record<string, number | string | null>;
  admet?: Record<string, number | string | null> | null;
  compliance: Record<string, unknown>;
  structural_alerts?: Record<string, unknown>;
}

export interface ApiUsage {
  credits?: number;
  credits_remaining?: number;
  credit_status?: 'ok' | 'low' | 'exhausted';
  credit_warning?: { credits_remaining: number; message: string; upgrade_url: string };
  tool?: string;
  source?: string;
  /** Server-resolved funnel slot for this call. Persists into the audit row. */
  funnel_id?: string;
}

/** Compute-tier results — loose typing since the four tools have different
 * payload shapes; the side panel renders generic key/value tables. */
export interface PkaResult { pka_predictions?: Array<{ pka: number; site?: string }>; pka?: number; [k: string]: unknown; }
export interface SolubilityResult { logS?: number; solubility_class?: string; [k: string]: unknown; }
export interface BdeResult { bonds?: Array<{ atoms: string; bde_kcal_mol: number }>; weakest_bond?: { atoms: string; bde_kcal_mol: number }; [k: string]: unknown; }
export interface FrontierOrbitalsResult { homo_eV?: number; lumo_eV?: number; gap_eV?: number; [k: string]: unknown; }

export interface ApiResponse<T> {
  result: T;
  usage: ApiUsage;
}

export interface ApiError {
  error: string;
  error_code?: string;
  message?: string;
  upgrade_url?: string;
  // Other tool-specific fields propagated from the structured-error response
  [key: string]: unknown;
}
