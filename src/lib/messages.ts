/**
 * Typed message contract between content script, service worker, popup,
 * and side panel. Every cross-boundary call routes through here so the
 * payload shapes are checked at the type level instead of `any`-passing.
 */
import type {
  ApiResponse, MoleculeProfile,
  PkaResult, SolubilityResult, BdeResult, FrontierOrbitalsResult,
} from '../types';

export type ComputeTool = 'predict_pka' | 'predict_solubility' | 'predict_bde' | 'predict_frontier_orbitals';
export interface ComputePayloads {
  predict_pka: PkaResult;
  predict_solubility: SolubilityResult;
  predict_bde: BdeResult;
  predict_frontier_orbitals: FrontierOrbitalsResult;
}

export interface PingRequest { type: 'PING'; }
export interface PingResponse { ok: true; authed: boolean; }

export interface OpenSidePanelRequest { type: 'OPEN_SIDE_PANEL'; }
export interface OpenSidePanelResponse { ok: true; }

export interface GetProfileRequest {
  type: 'GET_PROFILE';
  smiles: string;
  /** Hover-only — return cached entry or `data: null`; never fire a server call. */
  peek?: boolean;
}
export type GetProfileResponse =
  | { ok: true; cached: boolean; data: ApiResponse<MoleculeProfile> }
  | { ok: false; error: string; errorCode?: string };

export interface InvokeComputeRequest {
  type: 'INVOKE_COMPUTE';
  tool: ComputeTool;
  smiles: string;
}
export type InvokeComputeResponse<T extends ComputeTool = ComputeTool> =
  | { ok: true; tool: T; data: ApiResponse<ComputePayloads[T]> }
  | { ok: false; tool: T; error: string; errorCode?: string; status?: number };

export interface FetchAdmetRequest { type: 'FETCH_ADMET'; smiles: string; }
export type FetchAdmetResponse =
  | { ok: true; data: ApiResponse<Record<string, unknown>> }
  | { ok: false; error: string; errorCode?: string; status?: number };

export interface FetchComplianceRequest { type: 'FETCH_COMPLIANCE'; smiles: string; }
export type FetchComplianceResponse =
  | { ok: true; data: ApiResponse<Record<string, unknown>> }
  | { ok: false; error: string; errorCode?: string; status?: number };

export interface SearchSimilarRequest {
  type: 'SEARCH_SIMILAR';
  smiles: string;
  top_k?: number;
  min_similarity?: number;
}
export type SearchSimilarResponse =
  | { ok: true; data: ApiResponse<unknown> }
  | { ok: false; error: string; errorCode?: string; status?: number };

/** Side-panel selection broadcast — fired by content script, picked up by sidepanel. */
export interface SmilesSelectedEvent { type: 'SMILES_SELECTED'; smiles: string; }

export type AnyRequest =
  | PingRequest
  | OpenSidePanelRequest
  | GetProfileRequest
  | InvokeComputeRequest
  | SearchSimilarRequest
  | FetchAdmetRequest
  | FetchComplianceRequest
  | SmilesSelectedEvent;

export async function send<R = unknown>(msg: AnyRequest): Promise<R> {
  return chrome.runtime.sendMessage(msg) as Promise<R>;
}
