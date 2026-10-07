// CR-011 addendum C: the outside review's on/off switch, model and tier. Current settings = the newest row of the append-only
// review_settings_changes, else the defaults. Changed only through POST /reviews/settings (WRITE, audited).
import type { Kysely } from 'kysely';
import type { Database } from '../../../db/types.js';
import { ALLOWED_REVIEW_MODELS } from './gemini.js';

export interface ReviewSettings { enabled: boolean; model: string; tier: 'free' | 'paid' }
export interface ReviewSettingsView extends ReviewSettings { updatedAt: Date | null; updatedBy: string | null }

export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = { enabled: true, model: 'gemini-3.8-flash', tier: 'free' };

export async function currentReviewSettings(db: Kysely<Database>): Promise<ReviewSettingsView> {
  const r = await db.selectFrom('review_settings_changes').select(['enabled', 'model', 'tier', 'at', 'by']).orderBy('id', 'desc').limit(1).executeTakeFirst();
  return r ? { enabled: r.enabled, model: r.model, tier: r.tier, updatedAt: r.at, updatedBy: r.by } : { ...DEFAULT_REVIEW_SETTINGS, updatedAt: null, updatedBy: null };
}

export const allowedModelsView = () => ALLOWED_REVIEW_MODELS.map((m) => ({
  model: m.model, tier: m.free ? 'free' : 'paid', input_usd_per_m: m.input_usd_per_m, output_usd_per_m: m.output_usd_per_m,
}));
