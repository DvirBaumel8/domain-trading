// CAP-01 name form: tokenizer, SPELL-1, FORM-2 (short), G-FORM-1 (geo), geo length band, city+legal. Pure: no I/O, no clock.
// Every threshold comes from FormSettings (selection settings); nothing is hard-coded here except the mechanics of the search.
import { normalizeDomain } from '../domain-name.js';
import type { Lexicon, TokenType } from './lexicon.js';

export type Lane = 'S2' | 'S3' | 'S4' | 'S6' | 'S7';

export interface FormSettings {
  geo_bands: { max_chars: number | null; raw: number }[];
  unknown_token_fails: boolean;
  ambiguity_margin: number;
  token_costs: { typed: number; dict3: number; dict2: number };
  short_max_words: number;
  short_max_chars: number;
  geo_max_words: number;
  geo_max_chars: number;
  geo_city_one_token: boolean;
  formB_max_words: number;
  legal_terms_list: 'legal';
  /** FLAG AMBIGUOUS_SPLIT when a split has at least this many dictionary-only 2-letter tokens (animal·it·os); 0 turns it off. */
  short_token_flag_min: number;
  /** Read by buildLexicon: a place name that is also a dictionary word counts as a city only if listed here (or in city_extra). */
  city_word_allowlist: string[];
}

export interface FormResult {
  domain: string;
  sld: string;
  sld_len: number;
  has_digit: boolean;
  has_hyphen: boolean;
  tokens: string[];
  token_types: TokenType[];
  alternative_splits: string[][];
  ambiguous: boolean;
  unknown_tokens: string[];
  word_count: number;
  city: string | null;
  city_span: [number, number] | null;
  trade: string | null;
  trade_span: [number, number] | null;
  regime: string | null;
  keywords: string[];
  geo_length_band: number;
  city_plus_legal: boolean;
  short: 0 | 1;
  gform1_pass: boolean | null;
  status: 'PASS' | 'FLAG' | 'FAIL';
  reason_code: string | null;
  reason: string | null;
}

/** Cost of one unknown run: this constant plus one per character, so the search keeps unknown runs as short as it can. */
const UNKNOWN_RUN_BASE = 10;
const MAX_ENUMERATED_SPLITS = 2000;
const MAX_ALTERNATIVES = 3;

/** Which type names a token when a term has several (a city that is also a dictionary word is a city). */
const TYPE_PRIORITY: TokenType[] = ['city', 'trade', 'regime', 'tech', 'legal', 'generic_head', 'state', 'dictionary'];

/** G-FORM-1. `null` when the name is not geo; this exact function is reused by the replay (CAP-21a). */
export function gform1(
  nWords: number,
  sldChars: number,
  isGeo: boolean,
  cityTradeOk: boolean,
  s: Pick<FormSettings, 'geo_max_words' | 'geo_max_chars'>,
): boolean | null {
  if (!isGeo) return null;
  return cityTradeOk && nWords <= s.geo_max_words && sldChars <= s.geo_max_chars;
}

const maxTermLen = new WeakMap<Lexicon, number>();
function longestTerm(lex: Lexicon): number {
  let m = maxTermLen.get(lex);
  if (m === undefined) {
    m = 0;
    for (const t of lex.types.keys()) if (t.length > m) m = t.length;
    maxTermLen.set(lex, m);
  }
  return m;
}

function pickType(types: TokenType[]): TokenType {
  return TYPE_PRIORITY.find((t) => types.includes(t)) ?? 'dictionary';
}

interface Split {
  tokens: string[];
  cost: number;
  typed: number;
  hint: number;
}

const better = (a: Split, b: Split): number =>
  a.cost - b.cost ||
  b.typed - a.typed ||
  b.hint - a.hint ||
  (b.tokens[0]?.length ?? 0) - (a.tokens[0]?.length ?? 0) ||
  a.tokens.join('·').localeCompare(b.tokens.join('·'));

interface Seg {
  tokens: string[];
  alternatives: string[][];
  unknown: string[];
  /** `unknown` for the glued token when an unknown run was needed; same length as tokens. */
  forced: Map<number, TokenType>;
}

function segment(sld: string, lex: Lexicon, s: FormSettings, hintTerms: Set<string>): Seg {
  const n = sld.length;
  const maxLen = Math.min(n, longestTerm(lex));
  const { typed, dict3, dict2 } = s.token_costs;
  // tcost[i][j]: cost of the token sld[i..j) or null; isTyped marks a term with any non-dictionary type.
  const tcost: (number | null)[][] = Array.from({ length: n }, () => new Array<number | null>(n + 1).fill(null));
  const isTyped: boolean[][] = Array.from({ length: n }, () => new Array<boolean>(n + 1).fill(false));
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j <= Math.min(n, i + maxLen); j++) {
      const t = lex.types.get(sld.slice(i, j));
      if (!t) continue;
      const typedTerm = t.some((x) => x !== 'dictionary');
      tcost[i]![j] = typedTerm ? typed : j - i >= 3 ? dict3 : dict2;
      isTyped[i]![j] = typedTerm;
    }
  }

  // Cheapest complete split of sld[i..n); Infinity when none exists.
  const suf = new Array<number>(n + 1).fill(Infinity);
  suf[n] = 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = i + 2; j <= n; j++) {
      const c = tcost[i]![j];
      if (c != null && suf[j]! + c < suf[i]!) suf[i] = suf[j]! + c;
    }
  }

  if (Number.isFinite(suf[0]!)) {
    const bound = suf[0]! + Math.max(0, s.ambiguity_margin);
    const found: Split[] = [];
    const path: number[] = [0];
    const walk = (i: number, cost: number): void => {
      if (found.length >= MAX_ENUMERATED_SPLITS) return;
      if (i === n) {
        const tokens = path.slice(1).map((end, k) => sld.slice(path[k]!, end));
        let ty = 0;
        for (let k = 1; k < path.length; k++) if (isTyped[path[k - 1]!]![path[k]!]) ty++;
        found.push({ tokens, cost, typed: ty, hint: tokens.filter((t) => hintTerms.has(t)).length });
        return;
      }
      for (let j = i + 2; j <= n; j++) {
        const c = tcost[i]![j];
        if (c == null || cost + c + suf[j]! > bound) continue;
        path.push(j);
        walk(j, cost + c);
        path.pop();
      }
    };
    walk(0, 0);
    found.sort(better);
    const best = found[0]!;
    // An alternative reading only counts when it crosses the best split's word boundaries. A finer split of the same
    // letters (roofing / roof·ing, extend / ext·end) breaks a word rather than reading the name differently.
    const cuts = (tokens: string[]) => {
      const out = new Set<number>();
      let at = 0;
      for (const t of tokens) out.add((at += t.length));
      return out;
    };
    const bestCuts = cuts(best.tokens);
    const alternatives = found
      .slice(1)
      .filter((x) => {
        const c = cuts(x.tokens);
        return [...bestCuts].some((b) => !c.has(b));
      })
      .slice(0, MAX_ALTERNATIVES)
      .map((x) => x.tokens);
    return { tokens: best.tokens, alternatives, unknown: [], forced: new Map() };
  }

  // No complete split: allow ONE unknown run (any length, including a single stray letter) so it can be reported.
  // dp[u][i]: best (cost, typed) to cover sld[0..i) using u unknown runs; parent keeps the way back.
  type Cell = { cost: number; typed: number; from: number; unknownRun: boolean } | null;
  const dp: Cell[][] = [new Array<Cell>(n + 1).fill(null), new Array<Cell>(n + 1).fill(null)];
  dp[0]![0] = { cost: 0, typed: 0, from: -1, unknownRun: false };
  const improve = (u: number, j: number, cand: NonNullable<Cell>) => {
    const cur = dp[u]![j];
    if (!cur || cand.cost < cur.cost || (cand.cost === cur.cost && cand.typed > cur.typed)) dp[u]![j] = cand;
  };
  for (let i = 0; i < n; i++) {
    for (let u = 0; u < 2; u++) {
      const cell = dp[u]![i];
      if (!cell) continue;
      for (let j = i + 2; j <= n; j++) {
        const c = tcost[i]![j];
        if (c != null) improve(u, j, { cost: cell.cost + c, typed: cell.typed + (isTyped[i]![j] ? 1 : 0), from: i, unknownRun: false });
      }
      if (u === 0) for (let j = i + 1; j <= n; j++) improve(1, j, { cost: cell.cost + UNKNOWN_RUN_BASE + (j - i), typed: cell.typed, from: i, unknownRun: true });
    }
  }
  // Walk back from (1, n); a state (1, i) reached by a known token came from (1, from), and an unknown run came from (0, from).
  const pieces: { text: string; unknown: boolean }[] = [];
  let u = 1;
  let i = n;
  while (i > 0) {
    const cell = dp[u]![i]!;
    pieces.push({ text: sld.slice(cell.from, i), unknown: cell.unknownRun });
    if (cell.unknownRun) u = 0;
    i = cell.from;
  }
  pieces.reverse();
  // A single stray letter is glued to the word before it (cincinnati + o -> cincinnatio), or after it at the start.
  const k = pieces.findIndex((p) => p.unknown);
  const forced = new Map<number, TokenType>();
  if (pieces[k]!.text.length === 1 && pieces.length > 1) {
    const at = k > 0 ? k - 1 : k + 1;
    const merged = k > 0 ? pieces[at]!.text + pieces[k]!.text : pieces[k]!.text + pieces[at]!.text;
    const lo = Math.min(k, at);
    pieces.splice(lo, 2, { text: merged, unknown: true });
    forced.set(lo, 'unknown');
  } else forced.set(k, 'unknown');
  const unknownText = pieces.filter((p) => p.unknown).map((p) => p.text);
  return { tokens: pieces.map((p) => p.text), alternatives: [], unknown: unknownText, forced };
}

function spanOf(tokens: string[], idx: number): [number, number] {
  let start = 0;
  for (let t = 0; t < idx; t++) start += tokens[t]!.length;
  return [start, start + tokens[idx]!.length];
}

export function analyzeForm(
  domain: string,
  lane: Lane,
  lex: Lexicon,
  s: FormSettings,
  hints?: { city?: string; trade?: string },
): FormResult {
  const dom = normalizeDomain(domain);
  const sld = dom.slice(0, -'.com'.length);
  const isGeo = lane === 'S2';
  const has_digit = /[0-9]/.test(sld);
  const has_hyphen = sld.includes('-');
  const band = s.geo_bands.find((b) => b.max_chars == null || sld.length <= b.max_chars);
  const base: FormResult = {
    domain: dom,
    sld,
    sld_len: sld.length,
    has_digit,
    has_hyphen,
    tokens: [],
    token_types: [],
    alternative_splits: [],
    ambiguous: false,
    unknown_tokens: [],
    word_count: 0,
    city: null,
    city_span: null,
    trade: null,
    trade_span: null,
    regime: null,
    keywords: [],
    geo_length_band: band?.raw ?? 0,
    city_plus_legal: false,
    short: 0,
    gform1_pass: isGeo ? false : null,
    status: 'PASS',
    reason_code: null,
    reason: null,
  };
  if (has_digit) return { ...base, status: 'FAIL', reason_code: 'HAS_DIGIT', reason: 'The name contains a digit (SPELL-1: no digits, even in regime names)' };
  if (has_hyphen) return { ...base, status: 'FAIL', reason_code: 'HAS_HYPHEN', reason: 'The name contains a hyphen (SPELL-1)' };

  const hintTerms = new Set([hints?.city, hints?.trade].filter((h): h is string => !!h).map((h) => h.toLowerCase().replace(/[^a-z]/g, '')));
  const seg = segment(sld, lex, s, hintTerms);
  const token_types: TokenType[] = seg.tokens.map((t, idx) => seg.forced.get(idx) ?? pickType(lex.types.get(t) ?? ['dictionary']));
  const word_count = seg.tokens.length;
  const firstOf = (type: TokenType) => {
    const hinted = hints && (type === 'city' ? hints.city : type === 'trade' ? hints.trade : undefined)?.toLowerCase().replace(/[^a-z]/g, '');
    const all = token_types.map((ty, idx) => (ty === type ? idx : -1)).filter((idx) => idx >= 0);
    return (hinted ? all.find((idx) => seg.tokens[idx] === hinted) : undefined) ?? all[0] ?? -1;
  };
  const ci = firstOf('city');
  const ti = firstOf('trade');
  const ri = firstOf('regime');
  const hasLegal = token_types.some((ty, idx) => ty === 'legal' && !seg.forced.has(idx));
  const short: 0 | 1 = word_count <= s.short_max_words && sld.length <= s.short_max_chars ? 1 : 0;
  const keywords = seg.tokens.filter((t, idx) => ['dictionary', 'tech', 'regime'].includes(token_types[idx]!) && t.length >= 4);
  const cityTradeOk = ci >= 0 && ti >= 0;
  const gf = gform1(word_count, sld.length, isGeo, cityTradeOk, s);

  const result: FormResult = {
    ...base,
    tokens: seg.tokens,
    token_types,
    alternative_splits: seg.alternatives,
    ambiguous: seg.alternatives.length > 0,
    unknown_tokens: seg.unknown,
    word_count,
    city: ci >= 0 ? seg.tokens[ci]! : null,
    city_span: ci >= 0 ? spanOf(seg.tokens, ci) : null,
    trade: ti >= 0 ? seg.tokens[ti]! : null,
    trade_span: ti >= 0 ? spanOf(seg.tokens, ti) : null,
    regime: ri >= 0 ? seg.tokens[ri]! : null,
    keywords,
    city_plus_legal: ci >= 0 && hasLegal,
    short,
    gform1_pass: gf,
  };

  if (seg.unknown.length > 0 && s.unknown_token_fails) {
    return { ...result, status: 'FAIL', reason_code: 'UNKNOWN_TOKEN', reason: `Not a word, city or known term: ${seg.unknown.join(', ')}` };
  }
  if (isGeo) {
    if (word_count > s.geo_max_words) {
      return { ...result, status: 'FAIL', reason_code: 'GFORM1_WORDS', reason: `Geo name has ${word_count} words (G-FORM-1 allows at most ${s.geo_max_words})` };
    }
    if (sld.length > s.geo_max_chars) {
      return { ...result, status: 'FAIL', reason_code: 'GFORM1_LENGTH', reason: `Geo name is ${sld.length} characters (G-FORM-1 allows at most ${s.geo_max_chars})` };
    }
    if (!cityTradeOk) {
      return { ...result, status: 'FLAG', reason_code: 'GEO_ATTR_MISSING', reason: `Geo name needs a city and a trade word; missing: ${[ci < 0 ? 'city' : '', ti < 0 ? 'trade' : ''].filter(Boolean).join(' and ')}` };
    }
  }
  if (result.city_plus_legal) {
    return { ...result, status: 'FLAG', reason_code: 'CITY_PLUS_LEGAL', reason: 'City plus a legal term (lawyer, attorney, law): legal-services risk' };
  }
  if (result.ambiguous) {
    return { ...result, status: 'FLAG', reason_code: 'AMBIGUOUS_SPLIT', reason: `Several readings: ${[seg.tokens, ...seg.alternatives].map((t) => t.join('·')).join(' / ')}` };
  }
  // A split made of tiny dictionary words (it, os, ad) is usually a split of a longer word the list does not know.
  const tiny = seg.tokens.filter((t, idx) => t.length === 2 && token_types[idx] === 'dictionary' && (lex.types.get(t) ?? []).every((x) => x === 'dictionary'));
  if (s.short_token_flag_min > 0 && tiny.length >= s.short_token_flag_min) {
    return {
      ...result, ambiguous: true, status: 'FLAG', reason_code: 'AMBIGUOUS_SPLIT',
      reason: `The split ${seg.tokens.join('·')} has ${tiny.length} dictionary-only 2-letter tokens (${tiny.join(', ')}): the reading is unreliable`,
    };
  }
  return result;
}
