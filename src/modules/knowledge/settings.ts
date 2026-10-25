// CR-078 rule 5: the weights, half-lives and thresholds live in the versioned kb_settings rows (append-only; a new version by migration). Nothing here is a default.
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Database } from '../../db/types.js';

const num = z.number().finite();
const GRADES = ['A', 'B', 'C', 'D', 'F'] as const;
export type Grade = (typeof GRADES)[number];
export const KIND_KEYS = ['measured', 'reported_sale', 'experience', 'opinion'] as const;

export const KbValues = z.object({
  topics: z.array(z.string().regex(/^[a-z_]{2,40}$/)).min(1),
  half_life_days: z.record(z.string(), z.number().int().min(1).max(3650)),
  grade_weight: z.object({ A: num, B: num, C: num, D: num, F: num }),
  credibility_weight: z.object({ '1': num, '2': num, '3': num, '4': num, '5': num }),
  sample: z.object({ log_divisor: num.positive(), fixed_unmeasured: num, single_reported_sale: num }),
  kind_weight: z.object({ measured: num, reported_sale: num, experience: num, opinion: num }),
  thresholds: z.object({
    inconsistency_agreement: num, min_clusters: z.number().int().min(1), min_ab_clusters: z.number().int().min(0), imprecision_total_n: num,
    bias_share: num, indirect_share: num, stale_mean_r: num, step_up_agreement: num, step_up_min_a_clusters: z.number().int().min(1),
    high_agreement: num, high_min_a_clusters: z.number().int().min(1), recheck_r: num, echo_jaccard: num,
  }),
});
export type KbValuesT = z.infer<typeof KbValues>;
export interface KbSettings { version: number; values: KbValuesT }

export async function activeKbSettings(db: Kysely<Database>): Promise<KbSettings> {
  const row = await db.selectFrom('kb_settings').selectAll().orderBy('version', 'desc').executeTakeFirstOrThrow();
  return { version: row.version, values: KbValues.parse(row.values) };
}

/** Half-life of a claim in days: its own, else its topic's. */
export function halfLifeOf(s: KbSettings, claim: { topic: string; half_life_days: number | null }): number {
  return claim.half_life_days ?? s.values.half_life_days[claim.topic] ?? s.values.half_life_days.other ?? 730;
}

export const GRADE_ORDER: Record<Grade, number> = { A: 4, B: 3, C: 2, D: 1, F: 0 };
