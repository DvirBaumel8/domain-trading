// v2.16.0: the backup covers every table that holds business data; a new table must be exported or excluded here with a reason.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TABLE_FILES } from '../../../../src/modules/ops/jobs/backup-export.js';
import { ORDER } from '../../../../src/modules/ops/jobs/backup-import.js';

/** Written to their own files by collectBackupFiles (not under tables/). */
const SPECIAL = ['purchases', 'receipts', 'sales', 'audit_log'];

/** Tables left out of the backup on purpose, with the reason. */
const EXCLUDED: Record<string, string> = {
  api_tokens: 'secrets (hashed bearer tokens); a restore creates new ones with the admin command',
  idempotency_keys: 'replay cache, expires; a restored database starts clean',
  rdap_lookups: 'cache of public registry answers; refetched on demand',
  reference_files: 'cache of downloaded public reference lists (popularity list, IANA bootstrap); refreshed daily',
  namebio_keyword_stats: 'cache of NameBio free-endpoint keyword stats (v5.11.0, CR-062); refetched by the daily referenceRefresh step',
  namebio_calls: 'NameBio request log that enforces the rate limits (v5.11.0, CR-062); operational',
  job_runs: 'operational log of job step summaries; the audit rows keep the facts',
  job_queue_runs: 'operational queue of job runs (v3.0.0); the finished run is in job_runs',
  job_steps: 'operational queue of job steps (v3.0.0); a restored database starts with an empty queue',
  portfolio_checks: 'operational daily probes (registry, lander, blocklist); recomputed by the next daily run',
  scout_lessons: 'scout lessons (v5.3.0, CR-053): mutable notes kept in a Markdown file by Gavriel too; not in the backup until asked',
  engine_uploads: 'scoring-engine data (v5.4.0, CR-056): rebuilt from Gavriel\'s upload files; large, and the nightly export is off',
  engine_sales: 'scoring-engine data (v5.4.0, CR-056): rebuilt from Gavriel\'s upload files; large',
  engine_unsold: 'scoring-engine data (v5.4.0, CR-056): rebuilt from Gavriel\'s upload files; large',
  engine_endings: 'scoring-engine registry facts (v5.4.0, CR-056): refetched from RDAP by the daily engineEndings step; large',
  owned_ending_events: 'owned-name endings watch (v5.7.0, CR-058): append-only baseline and change log; the weekly check rebuilds the current state (a lost event is not re-raised); the nightly export is unconfigured',
  domain_rdap: 'loaded candidate-pool registry facts (v5.12.0, CR-063): reloaded from the bot\'s files; pruned daily',
  live_checks: 'loaded live/cc check rows (v5.12.0, CR-063): reloaded from the bot\'s files; pruned daily',
  tm_kills: 'loaded trademark kill terms (v5.12.0, CR-063): append-only, reloaded from the bot\'s file; the nightly export is unconfigured',
  bigco_names: 'loaded big-company names (v5.12.0, CR-063): append-only, reloaded from the bot\'s file; the nightly export is unconfigured',
  sales_comps: 'loaded graded comparable sales (v5.12.0, CR-063): reloaded from the bot\'s file; the nightly export is unconfigured',
  engine_models: 'scoring-engine model versions (v5.5.0, CR-056): retrained from the engine data by the weekly engineTrain step; large (trees, test rows)',
  visit_daily: 'daily visitor counts (v5.18.0, CR-068): aggregates only, kept 400 days, rebuilt by new hits; the afternic rows are reloaded from the CR-037 files',
  visit_forwards: 'registrar URL-forward state of POST /visits/forward (v5.18.0, CR-068): operational; the registrar holds the real forward',
  api_usage: 'rate and Web Risk usage counters; operational',
};

const created = (): string[] => {
  const names = new Set<string>();
  for (const f of readdirSync('migrations').filter((x) => x.endsWith('.sql'))) {
    const up = readFileSync(join('migrations', f), 'utf8').split(/^-- Down Migration/m)[0]!;
    for (const m of up.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?"?([a-z_]+)"?/gi)) names.add(m[1]!.toLowerCase());
    for (const m of up.matchAll(/DROP TABLE (?:IF EXISTS )?(?:public\.)?"?([a-z_]+)"?/gi)) names.delete(m[1]!.toLowerCase());
  }
  return [...names].sort();
};

describe('backup coverage', () => {
  it('every exported table has an import step', () => {
    const order = new Set(ORDER.map((o) => o.table));
    expect(TABLE_FILES.filter((t) => !order.has(t))).toEqual([]);
    expect(ORDER.map((o) => o.table).filter((t) => !(TABLE_FILES as readonly string[]).includes(t) && !SPECIAL.includes(t))).toEqual([]);
  });

  it('every table the migrations create is exported or excluded with a reason', () => {
    const exported = new Set<string>([...TABLE_FILES, ...SPECIAL]);
    const missing = created().filter((t) => !exported.has(t) && !(t in EXCLUDED));
    expect(missing).toEqual([]);
    expect(Object.keys(EXCLUDED).filter((t) => exported.has(t))).toEqual([]); // no table is both
    expect(Object.keys(EXCLUDED).filter((t) => !created().includes(t))).toEqual([]); // no stale exclusion
  });
});
