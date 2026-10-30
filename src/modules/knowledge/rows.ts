// CR-078: the row shapes of the six kinds (the same for the POST /kb/* routes and the repo files data/knowledge/*.jsonl) and their validation.
// Rows name each other by natural key (author name, source URL, claim_key / claim triplet, question slug), so a batch needs no ids.
import { z } from 'zod';
import { isIsoWithOffset, realYmd } from '../../core/dates.js';
import { canonicalUrl, sha256, urlHash } from './url.js';
import { minhashOf } from './minhash.js';

export const KINDS = ['author', 'source', 'question', 'claim', 'evidence', 'link'] as const;
export type Kind = (typeof KINDS)[number];
/** Parents before children: authors, then sources (they name an author), questions, claims (they name questions), evidence and links (they name sources and claims). */
export const KIND_ORDER: readonly Kind[] = KINDS;
export const KB_MAX_ROWS = 1000;
export const QUOTE_MAX_WORDS = 15;
export const EXCERPT_MAX_CHARS = 300;

const GRADE = z.enum(['A', 'B', 'C', 'D', 'F']);
const text = (max: number) => z.string().trim().min(1).max(max);
const ts = z.string().refine(isIsoWithOffset, 'must be ISO 8601 with an offset');
const num = z.number().finite();
export const wordCount = (s: string): number => s.trim().split(/\s+/).filter(Boolean).length;

const Author = z.object({
  name: text(120), handles: z.record(z.string().max(60), z.string().max(200)).optional(), first_seen: realYmd.optional(),
  verified_sales_count: z.number().int().min(0).optional(), verified_sales_source: text(300).optional(), years_active: num.min(0).optional(), track_score: num.min(0).max(1).optional(),
  grade: GRADE.default('F'), grade_reason: text(400).optional(), supersede: z.boolean().optional(),
}).strict().refine((r) => r.grade === 'F' || r.grade_reason !== undefined, { message: 'grade_reason is required unless the grade is F', path: ['grade_reason'] });

const Source = z.object({
  url: text(1000), publisher: text(200).optional(), author: text(120).optional(), title: text(400).optional(), published_at: ts.optional(), retrieved_at: ts.optional(),
  type: z.enum(['official_data', 'paper', 'dataset', 'news', 'practitioner_blog', 'forum_post', 'video', 'comment', 'vendor', 'aggregator', 'own_analysis']),
  access_method: z.enum(['rss', 'api', 'session_web', 'manual']).default('manual'), access_note: text(300).optional(),
  reliability: GRADE.default('F'), reliability_reason: text(400).optional(),
  conflict_of_interest: z.enum(['none', 'sells_service', 'sells_names', 'marketplace', 'unknown']).default('unknown'),
  excerpt: z.string().trim().max(EXCERPT_MAX_CHARS).optional(), topics: z.array(z.string().regex(/^[a-z_]{2,40}$/)).max(12).default([]),
  status: z.enum(['lead', 'read', 'graded', 'rejected']).default('lead'), rejected_reason: text(200).optional(), supersede: z.boolean().optional(),
}).strict()
  .refine((r) => r.reliability === 'F' || r.reliability_reason !== undefined, { message: 'reliability_reason is required unless the reliability is F', path: ['reliability_reason'] })
  .refine((r) => r.status !== 'graded' || r.reliability !== 'F', { message: 'a graded source needs a reliability other than F', path: ['status'] })
  .refine((r) => r.status !== 'rejected' || r.rejected_reason !== undefined, { message: 'rejected_reason is required when the status is rejected', path: ['rejected_reason'] });

const Question = z.object({
  slug: z.string().regex(/^[a-z0-9][a-z0-9_.-]{0,79}$/), text: text(500), options: z.array(text(120)).max(12).default([]), population: text(300).optional(), decision_owner: text(80).optional(),
}).strict().refine((r) => new Set(r.options).size === r.options.length, { message: 'options must be distinct', path: ['options'] });

const Claim = z.object({
  topic: z.string().regex(/^[a-z_]{2,40}$/), questions: z.array(z.string()).max(20).default([]), option: text(120).optional(), statement: text(400), variable: text(200),
  direction: z.enum(['increases', 'decreases', 'no_effect', 'value']), effect_value: num.optional(), effect_unit: text(40).optional(), effect_low: num.optional(), effect_high: num.optional(),
  population: text(300), date_range_start: realYmd.optional(), date_range_end: realYmd.optional(), half_life_days: z.number().int().min(1).max(3650).optional(), supersede: z.boolean().optional(),
}).strict()
  .refine((r) => !r.date_range_start || !r.date_range_end || r.date_range_start <= r.date_range_end, { message: 'date_range_start is after date_range_end', path: ['date_range_start'] })
  .refine((r) => r.effect_low === undefined || r.effect_high === undefined || r.effect_low <= r.effect_high, { message: 'effect_low is above effect_high', path: ['effect_low'] });

const Evidence = z.object({
  source: text(1000), claim_key: text(600).optional(), claim: z.object({ topic: z.string(), variable: text(200), population: text(300) }).strict().optional(),
  stance: z.enum(['supports', 'contradicts', 'qualifies']), credibility: z.number().int().min(1).max(5), sample_size: z.number().int().min(0).optional(),
  evidence_kind: z.enum(['measured', 'reported_sale', 'experience', 'opinion']), population_match: z.enum(['direct', 'indirect']).default('direct'), survivorship: z.boolean().default(false),
  claim_grade: GRADE.optional(), effect_value: num.optional(), quote: z.string().trim().min(1).optional(), locator: z.string().trim().max(200).default(''),
  extracted_by: text(80).optional(), extracted_at: ts.optional(), extraction_check: z.enum(['single', 'double_agreed', 'double_conflict']).default('single'), supersede: z.boolean().optional(),
}).strict()
  .refine((r) => (r.claim_key !== undefined) !== (r.claim !== undefined), { message: 'give exactly one of claim_key and claim {topic, variable, population}', path: ['claim_key'] })
  .refine((r) => r.quote === undefined || wordCount(r.quote) <= QUOTE_MAX_WORDS, { message: `quote must be at most ${QUOTE_MAX_WORDS} words`, path: ['quote'] });

const Link = z.object({
  from: text(1000), to: text(1000), kind: z.enum(['echo_of', 'cites', 'same_author', 'syndicated', 'aggregator_of']), note: text(300).optional(), retracted: z.boolean().default(false), supersede: z.boolean().optional(),
}).strict().refine((r) => r.kind !== 'same_author' || r.note !== undefined, { message: 'a same_author link needs a note naming the shared data', path: ['note'] });

export const SCHEMAS = { author: Author, source: Source, question: Question, claim: Claim, evidence: Evidence, link: Link } as const;
export type RowOf<K extends Kind> = z.infer<(typeof SCHEMAS)[K]>;

export const normText = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim().replace(/[.;,:]+$/, '');
/** topic | variable | population, lowercased and trimmed (research §2.2: one row per normalised statement shared by every source that makes it). */
export const claimKeyOf = (topic: string, variable: string, population: string): string => `${topic}|${normText(variable)}|${normText(population)}`;
export const authorKeyOf = (name: string): string => name.toLowerCase().replace(/\s+/g, ' ').trim();

/** v5.79.0 (CR-098 ask 3): an EXISTS_DIFFERENT reject also names the row's natural key and the fields that differ from the stored newest version. */
export interface RowReject { row: number; reason: string; message: string; key?: string; fields?: string[] }
export const issueText = (e: z.ZodError): string => e.issues.slice(0, 3).map((i) => `${i.path.join('.') || 'row'}: ${i.message}`).join('; ').slice(0, 300);

/** Source columns from a parsed source row: canonical URL and hash, the excerpt's content hash and MinHash. */
export function sourceCols(r: RowOf<'source'>): { url: string; url_hash: string; content_hash: string | null; minhash: string | null } | { error: string } {
  const url = canonicalUrl(r.url);
  if (!url) return { error: 'url must be an http(s) URL without credentials, at most 1000 characters' };
  return { url, url_hash: urlHash(url), content_hash: r.excerpt ? sha256(r.excerpt) : null, minhash: r.excerpt ? minhashOf(r.excerpt) : null };
}
