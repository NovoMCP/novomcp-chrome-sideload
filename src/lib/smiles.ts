/**
 * Client-side SMILES candidate extraction.
 *
 * Strategy (per Novo_Dist_Play.md §3 Detection method):
 *   1. Regex-match `[A-Za-z0-9@+\-\[\]()=#$/\\.]{6,150}` — loose by design.
 *   2. Sanity filter on the client to reject the *very common* false
 *      positives that show up on chemistry pages:
 *        - InChI keys (`AAAAAAAAAAAAAA-BBBBBBBBBB-C` — 14/10/1 uppercase)
 *        - InChI strings (`InChI=...`)
 *        - IUPAC names and chemical-name fragments (`2,3,6-triiodobenzaldehyde`,
 *          `methylpropanoate`, `phenylacetic acid`)
 *        - Chemical formulas (`C7H3I3O`)
 *        - SCHEMBL / CHEMBL / DB / CID identifier strings
 *        - URLs, hex hashes, English words
 *      Server-side validation remains the source of truth — the API
 *      rejects invalid SMILES with a structured error and we render that.
 *
 * The client filter exists to avoid wrapping every non-SMILES alphanumeric
 * blob in a hover affordance. False-positive cost is annoyance and UI
 * noise, not credits — get_molecule_profile's enriched-DB fast path costs
 * nothing for SMILES we've seen, and the novel branch validates server-side
 * before charging.
 */

const SMILES_REGEX = /[A-Za-z0-9@+\-\[\]()=#$/\\.]{6,150}/g;

const URL_OR_PATH = /^(https?:|\/|\.\.?\/|[a-z]+:\/\/)/i;
const HEX_LIKE = /^[0-9a-f]+$/i;
const ALL_DIGITS = /^[0-9.]+$/;
const PURE_LETTERS = /^[A-Za-z]+$/;

/**
 * InChI key shape: 14 uppercase letters + dash + 10 uppercase letters +
 * dash + 1 uppercase letter (e.g., `FMHOZWBIFYXAMA-UHFFFAOYSA-N`).
 */
const INCHI_KEY = /^[A-Z]{14}-[A-Z]{10}-[A-Z]$/;

/** Full InChI string starts with the version tag. */
const INCHI_STRING = /^InChI=/i;

/**
 * IUPAC names and chemical-name word fragments. These dominate compound
 * pages on PubChem / ChEMBL alongside the SMILES — without this filter
 * the underline shows up on the wrong line.
 */
const IUPAC_FRAGMENTS = /\b(methyl|ethyl|propyl|butyl|pentyl|hexyl|heptyl|octyl|amine|amide|amino|imine|aldehyde|carboxyl|carbonyl|hydroxy|benzene|benzoic|benzaldehyde|phenyl|pyridine|pyrrole|pyrim|pyrazol|imidazol|furan|thiophene|cyclohex|cyclopent|cyclobut|propan|butan|pentan|hexan|heptan|octan|ethan|methan|alcohol|alkene|alkyne|sulfonyl|chloride|fluoride|bromide|iodide|nitric|sulfuric|hydrochloric|acetic|formic|oxalic|tartaric|citric|salicylic|naphtha|anthracen|quinolin|indol|piperazin|piperidin|morpholin|azetidin|aziridin|oxetan|oxiran|guanidine|urea|aniline|toluen|xylene|biphenyl)/i;

/**
 * Database / catalog identifiers that look enough like SMILES to fool the
 * regex but never are.
 */
const DB_IDENTIFIER = /^(SCHEMBL|CHEMBL|MFCD|CID|DB|HMDB|KEGG|REAXYS|EINECS|RCSB)\d/i;

/**
 * Real SMILES *almost always* has at least one of: bracket atom (`[`),
 * branch (`(`), bond symbol (`=` `#`), chirality (`@`), or an aromatic
 * lowercase atom followed by ANOTHER chemistry character — NOT by an
 * arbitrary lowercase letter (which matched English text like
 * "likeness" via `ne`, "Caco" via `co`, "bonds" via `on`).
 */
const SMILES_FEATURE = /[\[\]()=#@]|[cnops][cnops0-9(=#\-/\\@\[]/;

/**
 * Outside bracket atoms (which can hold any element), real SMILES
 * letters come from a tiny set: B, C, N, O, P, S, F, H, I + lowercase
 * aromatics b, c, n, o, p, s + the second-letter-of-Cl/Br {l, r}. Any
 * other letter outside brackets means the candidate is English text,
 * not chemistry.
 */
const SIMPLE_SMILES_ALPHABET = 'BCNOPSFHIcnospblr';

const COMMON_WORDS = new Set([
  'because', 'between', 'through', 'however', 'therefore', 'although',
  'compound', 'molecule', 'structure', 'analysis', 'research', 'discovery',
  'platform', 'function', 'response', 'request', 'document', 'category',
  'available', 'including', 'features', 'science', 'support',
  'function', 'console', 'window', 'document', 'object', 'string',
  'number', 'boolean', 'undefined', 'default', 'export', 'import',
  'description', 'parameters', 'arguments', 'configuration',
]);

export interface SmilesMatch {
  smiles: string;
  start: number;
  end: number;
}

export function findSmilesCandidates(text: string): SmilesMatch[] {
  if (!text || text.length < 6) return [];
  const matches: SmilesMatch[] = [];
  let m: RegExpExecArray | null;
  SMILES_REGEX.lastIndex = 0;
  while ((m = SMILES_REGEX.exec(text)) !== null) {
    const candidate = m[0];
    if (!isLikelySmiles(candidate)) continue;
    matches.push({ smiles: candidate, start: m.index, end: m.index + candidate.length });
  }
  return matches;
}

export function isLikelySmiles(s: string): boolean {
  if (s.length < 6 || s.length > 150) return false;

  // SMILES never contains whitespace. Catches "MW (g/mol)", "Rot bonds",
  // "Caco-2 Permeability" — Word table cells full of human prose that
  // the table-validator was passing whole.
  if (/\s/.test(s)) return false;

  // Strong negative — these aren't SMILES, full stop
  if (URL_OR_PATH.test(s)) return false;
  if (ALL_DIGITS.test(s)) return false;
  if (INCHI_KEY.test(s)) return false;
  if (INCHI_STRING.test(s)) return false;
  if (DB_IDENTIFIER.test(s)) return false;
  if (IUPAC_FRAGMENTS.test(s)) return false;
  // SMILES never contains underscores — catches funnel_ids
  // (`funnel_xxx_20260101_...`, `fnl_u<hash>`) and identifier strings.
  if (s.includes('_')) return false;

  // Long all-uppercase + digits + dashes → InChI key fragment, formula
  // in caps, catalog code, gene symbol — never SMILES.
  if (/^[A-Z0-9\-]+$/.test(s) && s.length >= 8) return false;

  // Hex-only hashes (git SHAs, UUIDs without dashes)
  if (HEX_LIKE.test(s) && s.length >= 12) return false;

  // Pure letters short enough to be a word — and English-word common-set hits
  if (PURE_LETTERS.test(s)) {
    if (s.length < 14) return false;
    if (COMMON_WORDS.has(s.toLowerCase())) return false;
  }

  // Letters outside bracket atoms must come from the simple-SMILES
  // alphabet. Catches "Drug-likeness" (d, u, g, k, e), "P-gp Inhibitor"
  // (after we strip the space — but we already rejected for whitespace),
  // and any English token that snuck through the other gates.
  const stripped = s.replace(/\[[^\]]*\]/g, '');
  for (const ch of stripped) {
    if (/[a-zA-Z]/.test(ch) && !SIMPLE_SMILES_ALPHABET.includes(ch)) return false;
  }

  // Required positive signal — at least one bracket / paren / bond /
  // chirality / aromatic-atom-followed-by-another-chemistry-char.
  if (!SMILES_FEATURE.test(s)) return false;

  // Balanced brackets (cheap structural sanity; full parse stays server-side)
  if ((s.match(/\(/g)?.length ?? 0) !== (s.match(/\)/g)?.length ?? 0)) return false;
  if ((s.match(/\[/g)?.length ?? 0) !== (s.match(/\]/g)?.length ?? 0)) return false;

  return true;
}
