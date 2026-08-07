/**
 * ADMET field normalization — port of NovoWorkbench's normalizeAdmet.ts
 * (abridged for the side-panel surface). Maps API aliases to canonical
 * keys, attaches human-readable labels, and assigns each field to one of
 * five categories. Drives the per-category subsections in the side panel.
 *
 * Source: /Users/ariharrison/Documents/Github/NovoWorkbench/src/utils/normalizeAdmet.ts
 */

export type AdmetCategory = 'absorption' | 'distribution' | 'metabolism' | 'excretion' | 'toxicity';

export interface AdmetField {
  key: string;
  label: string;
  category: AdmetCategory;
  value: number;
  unit?: string;
  /** 'good' | 'moderate' | 'poor' | 'low' | 'high' | 'inhibitor' | 'substrate' | 'non-inhibitor' | 'non-substrate' */
  classification: string;
  /** higher value is better for the property (true) or worse (false) */
  higherIsBetter: boolean;
}

interface FieldDef {
  canonical: string;
  label: string;
  category: AdmetCategory;
  unit?: string;
  classify: (v: number) => string;
  aliases: string[];
  higherIsBetter: boolean;
}

const probGoodPoor = (v: number) => (v >= 0.7 ? 'good' : v >= 0.3 ? 'moderate' : 'poor');
const probLowHigh = (v: number) => (v < 0.3 ? 'low' : v < 0.7 ? 'moderate' : 'high');
const inhibitorClass = (v: number) => (v < 0.3 ? 'non-inhibitor' : v < 0.7 ? 'moderate' : 'inhibitor');
const substrateClass = (v: number) => (v < 0.3 ? 'non-substrate' : v < 0.7 ? 'moderate' : 'substrate');

const REGISTRY: FieldDef[] = [
  // Absorption
  { canonical: 'caco2_permeability', label: 'Caco-2 Permeability', category: 'absorption', unit: 'log cm/s', classify: (v) => (v > -5.15 ? 'good' : v > -6 ? 'moderate' : 'poor'), aliases: ['caco2_permeability', 'caco2'], higherIsBetter: true },
  { canonical: 'hia', label: 'Human Intestinal Absorption', category: 'absorption', classify: probGoodPoor, aliases: ['hia_probability', 'hia'], higherIsBetter: true },
  { canonical: 'pgp_inhibitor', label: 'P-gp Inhibitor', category: 'absorption', classify: inhibitorClass, aliases: ['pgp_inhibitor_probability', 'pgp_inhibitor'], higherIsBetter: false },
  { canonical: 'pgp_substrate', label: 'P-gp Substrate', category: 'absorption', classify: substrateClass, aliases: ['pgp_substrate_probability', 'pgp_substrate'], higherIsBetter: false },
  { canonical: 'bioavailability', label: 'Oral Bioavailability', category: 'absorption', classify: probGoodPoor, aliases: ['bioavailability_probability', 'bioavailability', 'oral_bioavailability_20'], higherIsBetter: true },
  { canonical: 'lipophilicity', label: 'Lipophilicity', category: 'absorption', unit: 'log', classify: (v) => (v >= 1 && v <= 5 ? 'good' : v >= 0 && v <= 6 ? 'moderate' : 'poor'), aliases: ['lipophilicity_log_ratio', 'lipophilicity', 'lipophilicity_logp'], higherIsBetter: true },

  // Distribution
  { canonical: 'bbb', label: 'Blood-Brain Barrier', category: 'distribution', classify: probLowHigh, aliases: ['bbb_martins', 'bbb', 'bbb_probability'], higherIsBetter: false },
  { canonical: 'ppbr', label: 'Plasma Protein Binding', category: 'distribution', unit: '%', classify: (v) => (v < 90 ? 'good' : v < 99 ? 'moderate' : 'poor'), aliases: ['ppbr_percent', 'ppbr', 'plasma_protein_binding'], higherIsBetter: false },
  { canonical: 'vdss', label: 'Steady-State Volume of Distribution', category: 'distribution', unit: 'L/kg', classify: (v) => (v > 0.04 && v < 20 ? 'good' : 'moderate'), aliases: ['vdss_L_kg', 'vdss', 'vd_steady_state'], higherIsBetter: true },

  // Metabolism (CYP)
  { canonical: 'cyp1a2_inhibitor', label: 'CYP1A2 Inhibitor', category: 'metabolism', classify: inhibitorClass, aliases: ['cyp1a2_inhibitor_probability', 'cyp1a2_inhibitor', 'cyp_1a2_inhibitor'], higherIsBetter: false },
  { canonical: 'cyp2c9_inhibitor', label: 'CYP2C9 Inhibitor', category: 'metabolism', classify: inhibitorClass, aliases: ['cyp2c9_inhibitor_probability', 'cyp2c9_inhibitor'], higherIsBetter: false },
  { canonical: 'cyp2c19_inhibitor', label: 'CYP2C19 Inhibitor', category: 'metabolism', classify: inhibitorClass, aliases: ['cyp2c19_inhibitor_probability', 'cyp2c19_inhibitor'], higherIsBetter: false },
  { canonical: 'cyp2d6_inhibitor', label: 'CYP2D6 Inhibitor', category: 'metabolism', classify: inhibitorClass, aliases: ['cyp2d6_inhibitor_probability', 'cyp2d6_inhibitor'], higherIsBetter: false },
  { canonical: 'cyp3a4_inhibitor', label: 'CYP3A4 Inhibitor', category: 'metabolism', classify: inhibitorClass, aliases: ['cyp3a4_inhibitor_probability', 'cyp3a4_inhibitor'], higherIsBetter: false },
  { canonical: 'cyp3a4_substrate', label: 'CYP3A4 Substrate', category: 'metabolism', classify: substrateClass, aliases: ['cyp3a4_substrate_probability', 'cyp3a4_substrate'], higherIsBetter: false },
  { canonical: 'cyp2d6_substrate', label: 'CYP2D6 Substrate', category: 'metabolism', classify: substrateClass, aliases: ['cyp2d6_substrate_probability', 'cyp2d6_substrate'], higherIsBetter: false },
  { canonical: 'cyp2c9_substrate', label: 'CYP2C9 Substrate', category: 'metabolism', classify: substrateClass, aliases: ['cyp2c9_substrate_probability', 'cyp2c9_substrate'], higherIsBetter: false },

  // Excretion
  { canonical: 'half_life', label: 'Plasma Half-Life', category: 'excretion', unit: 'hr', classify: (v) => (v >= 4 && v <= 24 ? 'good' : 'moderate'), aliases: ['half_life_hr', 'half_life'], higherIsBetter: true },
  { canonical: 'clearance_hepatocyte', label: 'Hepatocyte Clearance', category: 'excretion', unit: 'µL/min/1e6 cells', classify: (v) => (v < 5 ? 'good' : v < 50 ? 'moderate' : 'poor'), aliases: ['clearance_hepatocyte', 'clearance_hep'], higherIsBetter: false },
  { canonical: 'clearance_microsome', label: 'Microsome Clearance', category: 'excretion', unit: 'mL/min/g', classify: (v) => (v < 5 ? 'good' : v < 50 ? 'moderate' : 'poor'), aliases: ['clearance_microsome', 'clearance_micro'], higherIsBetter: false },

  // Toxicity
  { canonical: 'herg', label: 'hERG Blocker', category: 'toxicity', classify: probLowHigh, aliases: ['herg_blocker_probability', 'herg', 'hERG', 'cardiotox_herg'], higherIsBetter: false },
  { canonical: 'hepatotoxicity', label: 'Hepatotoxicity', category: 'toxicity', classify: probLowHigh, aliases: ['hepatotoxicity_probability', 'hepatotoxicity'], higherIsBetter: false },
  { canonical: 'ames', label: 'Ames Mutagenicity', category: 'toxicity', classify: probLowHigh, aliases: ['ames_mutagenicity_probability', 'ames_mutagenicity', 'ames'], higherIsBetter: false },
  { canonical: 'carcinogenicity', label: 'Carcinogenicity', category: 'toxicity', classify: probLowHigh, aliases: ['carcinogenicity_probability', 'carcinogenicity'], higherIsBetter: false },
  // Cardiotoxicity keyed on the validated DICTrank head `cardiotoxicity_dict`.
  // Legacy `cardiotoxicity_max` aliases retained as a fallback so cached or
  // older-backend responses still render.
  { canonical: 'cardiotoxicity_dict', label: 'Cardiotoxicity', category: 'toxicity', classify: probLowHigh, aliases: ['cardiotoxicity_dict', 'cardiotoxicity_dict_probability', 'cardiotoxicity', 'cardiotoxicity_max_probability', 'cardiotoxicity_max'], higherIsBetter: false },
  { canonical: 'clinical_toxicity', label: 'Clinical Toxicity', category: 'toxicity', classify: probLowHigh, aliases: ['clinical_toxicity_probability', 'clinical_toxicity'], higherIsBetter: false },
  { canonical: 'developmental_toxicity', label: 'Developmental Toxicity', category: 'toxicity', classify: probLowHigh, aliases: ['developmental_toxicity_probability', 'developmental_toxicity'], higherIsBetter: false },
  { canonical: 'reproductive_toxicity', label: 'Reproductive Toxicity', category: 'toxicity', classify: probLowHigh, aliases: ['reproductive_toxicity_probability', 'reproductive_toxicity'], higherIsBetter: false },
  { canonical: 'respiratory_toxicity', label: 'Respiratory Toxicity', category: 'toxicity', classify: probLowHigh, aliases: ['respiratory_toxicity_probability', 'respiratory_toxicity'], higherIsBetter: false },
  { canonical: 'skin_sensitization', label: 'Skin Sensitization', category: 'toxicity', classify: probLowHigh, aliases: ['skin_sensitization_probability', 'skin_sensitization'], higherIsBetter: false },
  { canonical: 'eye_corrosion', label: 'Eye Corrosion', category: 'toxicity', classify: probLowHigh, aliases: ['eye_corrosion_probability', 'eye_corrosion'], higherIsBetter: false },
  { canonical: 'eye_irritation', label: 'Eye Irritation', category: 'toxicity', classify: probLowHigh, aliases: ['eye_irritation_probability', 'eye_irritation'], higherIsBetter: false },
  { canonical: 'overall_toxicity', label: 'Overall Toxicity Score', category: 'toxicity', classify: probLowHigh, aliases: ['overall_toxicity_score', 'overall_toxicity'], higherIsBetter: false },

  // Nuclear receptors (rolled into toxicity for the small surface)
  { canonical: 'nr_ar', label: 'AR (Androgen Receptor)', category: 'toxicity', classify: probLowHigh, aliases: ['nr_ar_probability', 'nr_ar', 'ar_agonist'], higherIsBetter: false },
  { canonical: 'nr_ahr', label: 'AhR Agonist', category: 'toxicity', classify: probLowHigh, aliases: ['nr_ahr_agonist_probability', 'nr_ahr', 'ahr_agonist'], higherIsBetter: false },
  { canonical: 'nr_er', label: 'ER (Estrogen Receptor)', category: 'toxicity', classify: probLowHigh, aliases: ['nr_er_probability', 'nr_er', 'er_agonist'], higherIsBetter: false },
  { canonical: 'nr_aromatase', label: 'Aromatase Inhibitor', category: 'toxicity', classify: probLowHigh, aliases: ['nr_aromatase_probability', 'nr_aromatase'], higherIsBetter: false },

  // Stress response (rolled into toxicity)
  { canonical: 'sr_p53', label: 'p53 Activation', category: 'toxicity', classify: probLowHigh, aliases: ['sr_p53_probability', 'sr_p53'], higherIsBetter: false },
  { canonical: 'sr_are', label: 'ARE / Oxidative Stress', category: 'toxicity', classify: probLowHigh, aliases: ['sr_are_probability', 'sr_are', 'are_response'], higherIsBetter: false },
];

// Index aliases → field def for O(1) lookup
const ALIAS_INDEX = new Map<string, FieldDef>();
for (const def of REGISTRY) {
  for (const alias of def.aliases) ALIAS_INDEX.set(alias.toLowerCase(), def);
}

/**
 * Walk the API response (which contains both nested category objects and
 * a flat raw_predictions bag) and produce a category-keyed registry of
 * AdmetField records. Two-phase: named sections first, raw_predictions as
 * fallback (skip already-seen fields).
 */
export function normalize(response: Record<string, unknown>): Record<AdmetCategory, AdmetField[]> {
  const out: Record<AdmetCategory, AdmetField[]> = {
    absorption: [], distribution: [], metabolism: [], excretion: [], toxicity: [],
  };
  const seen = new Set<string>();

  const collect = (key: string, value: unknown): void => {
    if (typeof value !== 'number' || !isFinite(value)) return;
    const def = ALIAS_INDEX.get(key.toLowerCase());
    if (!def) return;
    if (seen.has(def.canonical)) return;
    seen.add(def.canonical);
    out[def.category].push({
      key: def.canonical,
      label: def.label,
      category: def.category,
      value,
      unit: def.unit,
      classification: def.classify(value),
      higherIsBetter: def.higherIsBetter,
    });
  };

  // Phase A — named category sections
  for (const section of ['absorption', 'distribution', 'metabolism', 'excretion', 'toxicity', 'nuclear_receptors', 'stress_response']) {
    const block = response[section];
    if (!block || typeof block !== 'object') continue;
    for (const [k, v] of Object.entries(block as Record<string, unknown>)) collect(k, v);
  }

  // Phase B — raw_predictions fallback for fields the named sections missed
  const raw = response['raw_predictions'];
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) collect(k, v);
  }

  // Phase C — top-level keys (older response shapes occasionally bubble fields up)
  for (const [k, v] of Object.entries(response)) {
    if (typeof v === 'object') continue;
    collect(k, v);
  }

  // Sort each category: critical-classification first, then by label
  const RANK: Record<string, number> = { high: 0, inhibitor: 0, substrate: 1, poor: 0, moderate: 2, good: 3, low: 3, 'non-inhibitor': 3, 'non-substrate': 3 };
  for (const cat of Object.keys(out) as AdmetCategory[]) {
    out[cat].sort((a, b) => {
      const ra = RANK[a.classification] ?? 5;
      const rb = RANK[b.classification] ?? 5;
      if (ra !== rb) return ra - rb;
      return a.label.localeCompare(b.label);
    });
  }

  return out;
}

/** Color for a classification — japandi tokens, derived. */
export function classificationColor(c: string): string {
  if (c === 'good' || c === 'low' || c === 'non-inhibitor' || c === 'non-substrate') return 'var(--success)';
  if (c === 'moderate') return 'var(--text-soft)';
  if (c === 'poor' || c === 'high' || c === 'inhibitor' || c === 'substrate') return 'var(--accent)';
  return 'var(--text-muted)';
}
