// CR-078 rule 3-6, research §2.3 C and D: the weight of one evidence item, independence clusters, the verdict per question and its GRADE-style certainty.
// Pure functions of the stored rows and the versioned kb_settings: no I/O, no clock (the caller passes the age), no AI.
import { GRADE_ORDER, type Grade, type KbSettings } from './settings.js';

export type Certainty = 'high' | 'moderate' | 'low' | 'very_low';
const LEVELS: Certainty[] = ['very_low', 'low', 'moderate', 'high'];
export type Stance = 'supports' | 'contradicts' | 'qualifies';
export type EvKind = 'measured' | 'reported_sale' | 'experience' | 'opinion';

/** One evidence row with the facts of its source and claim that the weight needs. `source` is the root id of the source (links name roots). */
export interface Item {
  evidenceId: number; source: number; sourceUrl: string; sourceType: string; sourceStatus: string; conflict: string;
  /** The grade used: the source's reliability, lowered by the evidence's claim_grade when that is lower. */
  grade: Grade;
  claimKey: string; option: string | null; stance: Stance; credibility: number; sampleSize: number | null; kind: EvKind;
  populationMatch: 'direct' | 'indirect'; survivorship: boolean; effectValue: number | null; effectUnit: string | null;
  halfLifeDays: number; ageDays: number;
}

export interface Weight { G: number; C: number; N: number; R: number; K: number; w: number; wNoAge: number }

/** w = G x C x N x R x K (research §2.3 C). A rejected source weighs nothing. */
export function weightOf(it: Item, s: KbSettings): Weight {
  const v = s.values;
  const G = it.sourceStatus === 'rejected' ? 0 : v.grade_weight[it.grade];
  const C = v.credibility_weight[String(it.credibility) as '1'];
  const measured = it.kind === 'measured' || (it.kind === 'reported_sale' && (it.sampleSize ?? 0) > 1);
  let N: number;
  if (it.kind === 'reported_sale' && it.sampleSize === 1) N = v.sample.single_reported_sale;
  else if (measured && it.sampleSize !== null) N = Math.min(1, Math.log10(it.sampleSize + 1) / v.sample.log_divisor);
  else N = v.sample.fixed_unmeasured;
  const R = Math.pow(0.5, Math.max(0, it.ageDays) / it.halfLifeDays);
  const K = v.kind_weight[it.kind];
  const wNoAge = G * C * N * K;
  return { G, C, N, R, K, w: wNoAge * R, wNoAge };
}

/** Union-find over source ids: edges are echo_of, syndicated, same_author (same data) and aggregator_of links that are not retracted. Returns source id -> cluster id (the smallest member id). */
export function clusterOf(sources: number[], edges: [number, number][]): Map<number, number> {
  const parent = new Map<number, number>();
  const find = (x: number): number => {
    let r = x;
    while ((parent.get(r) ?? r) !== r) r = parent.get(r)!;
    let c = x;
    while (c !== r) { const n = parent.get(c) ?? c; parent.set(c, r); c = n; }
    return r;
  };
  const union = (a: number, b: number) => { const ra = find(a), rb = find(b); if (ra !== rb) parent.set(Math.max(ra, rb), Math.min(ra, rb)); };
  for (const [a, b] of edges) union(a, b);
  return new Map(sources.map((s) => [s, find(s)]));
}

export interface ClusterView {
  cluster_id: number; grade: Grade; stance: Stance; w: number; evidence_id: number; kind: EvKind; members: number;
  sources: { id: number; url: string; type: string; reliability: Grade }[];
}
export interface OptionView { option: string | null; w_for: number; w_against: number; agreement: number | null; clusters: number }
export interface Numeric { median: number; low: number; high: number; unit: string | null; clusters: number }
export interface Verdict {
  leading_option: string | null; direction: 'supported' | 'contradicted' | 'unclear'; options: OptionView[]; numeric: Numeric | null;
  clusters_n: number; ab_clusters_n: number; a_clusters_n: number; agreement: number | null; total_n: number;
}
export interface VerdictResult {
  verdict: Verdict; certainty: Certainty; downgrades: string[]; clusters: ClusterView[]; weight_for: number; weight_against: number;
  items: { evidence_id: number; source: number; cluster: number; option: string | null; stance: Stance; grade: Grade; weight: Weight }[];
}

const pct = (x: number) => `${Math.round(x * 100)}%`;
const r2 = (x: number) => Math.round(x * 100) / 100;

interface Wi { it: Item; wt: Weight; cluster: number }

function weightedMedian(vals: { v: number; w: number }[]): number {
  const s = [...vals].sort((a, b) => a.v - b.v);
  const half = s.reduce((a, x) => a + x.w, 0) / 2;
  let acc = 0;
  for (const x of s) { acc += x.w; if (acc >= half) return x.v; }
  return s[s.length - 1]!.v;
}

/** The verdict of a question from its evidence items and the link edges. `options` are the question's options (empty = one open question). */
export function computeVerdict(o: { options: string[]; items: Item[]; edges: [number, number][]; settings: KbSettings }): VerdictResult {
  const { settings: s } = o;
  const th = s.values.thresholds;
  const cl = clusterOf([...new Set(o.items.map((i) => i.source))], o.edges);
  const all: Wi[] = o.items.map((it) => ({ it, wt: weightOf(it, s), cluster: cl.get(it.source)! }));
  const members = new Map<number, Set<number>>();
  for (const x of all) (members.get(x.cluster) ?? members.set(x.cluster, new Set()).get(x.cluster)!).add(x.it.source);
  const srcInfo = new Map<number, Item>();
  for (const x of all) srcInfo.set(x.it.source, x.it);

  // per option: the strongest supporting and contradicting item of every cluster (echoes add nothing)
  const groups: (string | null)[] = o.options.length > 0 ? o.options : [null];
  const perGroup = groups.map((g) => {
    const inGroup = all.filter((x) => (g === null || x.it.option === g) && x.wt.w > 0 && x.it.stance !== 'qualifies');
    const best = (stance: Stance) => {
      const m = new Map<number, Wi>();
      for (const x of inGroup) if (x.it.stance === stance) { const c = m.get(x.cluster); if (!c || x.wt.w > c.wt.w) m.set(x.cluster, x); }
      return m;
    };
    const sup = best('supports'), con = best('contradicts');
    const w_for = [...sup.values()].reduce((a, x) => a + x.wt.w, 0);
    const w_against = [...con.values()].reduce((a, x) => a + x.wt.w, 0);
    return { g, inGroup, sup, con, w_for, w_against, net: w_for - w_against };
  });
  const options: OptionView[] = perGroup.map((p) => ({
    option: p.g, w_for: r2(p.w_for), w_against: r2(p.w_against), agreement: p.w_for + p.w_against > 0 ? r2(p.w_for / (p.w_for + p.w_against)) : null,
    clusters: new Set([...p.sup.keys(), ...p.con.keys()]).size,
  }));

  const ranked = [...perGroup].sort((a, b) => b.net - a.net);
  const top = ranked[0]!;
  const lead = top && top.net > 0 && (ranked.length < 2 || top.net > ranked[1]!.net) ? top : null;
  const focus = lead ?? (o.options.length === 0 ? top : null);
  const downgrades: string[] = [];
  const empty = (why: string): VerdictResult => ({
    verdict: { leading_option: null, direction: 'unclear', options, numeric: null, clusters_n: 0, ab_clusters_n: 0, a_clusters_n: 0, agreement: null, total_n: 0 },
    certainty: 'very_low', downgrades: [why], clusters: [], weight_for: 0, weight_against: 0,
    items: all.map((x) => ({ evidence_id: x.it.evidenceId, source: x.it.source, cluster: x.cluster, option: x.it.option, stance: x.it.stance, grade: x.it.grade, weight: x.wt })),
  });
  if (!focus || focus.w_for + focus.w_against === 0) {
    return empty(all.some((x) => x.wt.w > 0) ? 'the options tie or the evidence against is as strong as the evidence for' : 'no evidence with a weight above 0 yet (D- and F-grade, rejected or unjudged sources weigh nothing)');
  }

  // clusters that bear on the focus: strongest item of each, either stance
  const repMap = new Map<number, Wi>();
  for (const x of [...focus.sup.values(), ...focus.con.values()]) { const c = repMap.get(x.cluster); if (!c || x.wt.w > c.wt.w) repMap.set(x.cluster, x); }
  const reps = [...repMap.values()].sort((a, b) => b.wt.w - a.wt.w);
  const agreement = focus.w_for / (focus.w_for + focus.w_against);
  const isAB = (x: Wi) => GRADE_ORDER[x.it.grade] >= GRADE_ORDER.B;
  const clustersN = reps.length;
  const abN = reps.filter(isAB).length;
  const supportingA = [...focus.sup.values()].filter((x) => x.it.grade === 'A');
  const aN = supportingA.length;
  const totalN = reps.reduce((a, x) => a + x.wt.N, 0);
  const sumW = reps.reduce((a, x) => a + x.wt.w, 0);

  // starting level
  let level = [...focus.sup.values()].some((x) => x.it.grade === 'A' && x.it.kind === 'measured') ? 2 : 1;
  let downs = 0;
  if (agreement < th.inconsistency_agreement) { downs++; downgrades.push(`inconsistent: only ${pct(agreement)} of the weight agrees (${pct(th.inconsistency_agreement)} needed)`); }
  const indirect = reps.filter((x) => x.it.populationMatch === 'indirect').reduce((a, x) => a + x.wt.w, 0) / sumW;
  if (indirect > th.indirect_share) { downs++; downgrades.push(`indirect: ${pct(indirect)} of the weight comes from a different population than ours`); }
  if (clustersN < th.min_clusters || totalN < th.imprecision_total_n) {
    downs++;
    downgrades.push(clustersN < th.min_clusters ? `imprecise: only ${clustersN} independent cluster${clustersN === 1 ? '' : 's'} (${th.min_clusters} needed)` : `imprecise: the samples are small (total sample weight ${r2(totalN)}, ${th.imprecision_total_n} needed)`);
  }
  const biased = reps.filter((x) => x.it.survivorship || ['sells_service', 'sells_names', 'marketplace'].includes(x.it.conflict)).reduce((a, x) => a + x.wt.w, 0) / sumW;
  if (biased > th.bias_share) { downs++; downgrades.push(`biased: ${pct(biased)} of the weight is self-reported wins or comes from sources with a conflict of interest`); }
  const sumNoAge = reps.reduce((a, x) => a + x.wt.wNoAge, 0);
  const meanR = sumNoAge > 0 ? reps.reduce((a, x) => a + x.wt.R * x.wt.wNoAge, 0) / sumNoAge : 0;
  if (meanR < th.stale_mean_r) { downs++; downgrades.push(`stale: the evidence has lost ${pct(1 - meanR)} of its weight to age (re-check it)`); }

  const own = [...focus.sup.values()].some((x) => x.it.sourceType === 'own_analysis');
  let up = 0;
  if (agreement >= th.step_up_agreement && (aN >= th.step_up_min_a_clusters || own)) up = 1;
  level = Math.max(0, Math.min(3, level - downs + up));
  if (level === 3 && !(clustersN >= th.min_clusters && aN >= th.high_min_a_clusters && agreement >= th.high_agreement && downs === 0)) level = 2;
  if (!(clustersN >= th.min_clusters && abN >= th.min_ab_clusters)) {
    level = 0;
    downgrades.push(`not enough independent evidence: ${clustersN} cluster${clustersN === 1 ? '' : 's'}, ${abN} of them graded A or B (${th.min_clusters} clusters with ${th.min_ab_clusters} A or B needed for anything above very low)`);
  }

  // a number: the weighted median over the strongest valued item of each cluster
  const valued = new Map<number, Wi>();
  for (const x of focus.inGroup) if (x.it.stance === 'supports' && x.it.effectValue !== null) { const c = valued.get(x.cluster); if (!c || x.wt.w > c.wt.w) valued.set(x.cluster, x); }
  const vs = [...valued.values()];
  const numeric: Numeric | null = vs.length === 0 ? null : {
    median: weightedMedian(vs.map((x) => ({ v: x.it.effectValue!, w: x.wt.w }))), low: Math.min(...vs.map((x) => x.it.effectValue!)), high: Math.max(...vs.map((x) => x.it.effectValue!)),
    unit: vs[0]!.it.effectUnit, clusters: vs.length,
  };

  const clusters: ClusterView[] = reps.slice(0, 10).map((x) => ({
    cluster_id: x.cluster, grade: x.it.grade, stance: x.it.stance, w: r2(x.wt.w), evidence_id: x.it.evidenceId, kind: x.it.kind, members: members.get(x.cluster)!.size,
    sources: [...members.get(x.cluster)!].sort((a, b) => a - b).slice(0, 5).map((id) => ({ id, url: srcInfo.get(id)!.sourceUrl, type: srcInfo.get(id)!.sourceType, reliability: srcInfo.get(id)!.grade })),
  }));
  const direction = focus.net > 0 ? 'supported' : focus.net < 0 ? 'contradicted' : 'unclear';
  return {
    verdict: { leading_option: lead ? lead.g : null, direction, options, numeric, clusters_n: clustersN, ab_clusters_n: abN, a_clusters_n: aN, agreement: r2(agreement), total_n: r2(totalN) },
    certainty: LEVELS[level]!, downgrades, clusters, weight_for: r2(focus.w_for), weight_against: r2(focus.w_against),
    items: all.map((x) => ({ evidence_id: x.it.evidenceId, source: x.it.source, cluster: x.cluster, option: x.it.option, stance: x.it.stance, grade: x.it.grade, weight: x.wt })),
  };
}
