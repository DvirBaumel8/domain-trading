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
  snapshot_manifests: 'daily data save manifests (v5.21.0, CR-071); the sources are public files and the sha256 is in the manifest; operational',
  datasave_pool: 'three days of parsed public closeouts (v5.21.0, CR-071); rebuilt by the next save',
  dynadot_rows: 'rows the bots upload from Dynadot (v5.22.0, CR-071); public market data the bots can upload again, sealed by the manifest sha256; operational',
  godaddy_auctions: 'GoDaddy auction final states (v5.22.0, CR-071 R-10); public market data, rebuilt going forward from the daily files; operational',
  godaddy_auctions_live: 'GoDaddy auctions at or under the S8 cap with bids (v5.37.0), kept 7 days; public market data rebuilt by the next daily files; operational',
  auction_shortlist: 'daily auction shortlist (v5.45.0, G-127): derived by the datasave step auctionShortlist from godaddy_auctions_live, engine_endings and the stored pre-bid checks (which are in the backup), replaced per data date; rebuilt by the next daily run',
  market_names: 'market episodes (v5.23.0, CR-075): derived by the datasave `episodes` step from the sealed snapshots and market_sales, so a restore rebuilds them (only the rows whose Dynadot source rows were pruned after 120 days would be lost); small by design (only $500+ episodes); the nightly export is unconfigured',
  market_sales: 'bot-reported sales (v5.23.0, CR-075 R-4): add-only and re-uploadable from the bots\' weekly files (POST /data/sales is idempotent on name, venue, date and source); the nightly export is unconfigured',
  market_dq_runs: 'market data-quality run log (v5.23.0, CR-075): operational, the last 90 runs; the next datasave run writes a new one',
  market_matched_sets: 'frozen matched sets (v5.23.0, CR-075 R-6): append-only experiment records with their sha256; a restore would lose the freeze, so Challenger keeps the sha256 it graded against; the nightly export is unconfigured',
  pickproof_days: 'pick-proof day records (v5.28.0, CR-073): the pool sha256, seed and arm hashes of each pick day; the bots append every seal to docs/requests/pick-proof-seals.md (the git witness), so a restore can be checked against it; the nightly export is unconfigured',
  pickproof_pool: 'frozen daily pick-proof pool (v5.28.0, CR-073): about 125,000 rows a day, kept 45 days and derived from the datasave rows; too large for the backup, the sha256 stays in pickproof_days',
  pickproof_arms: 'pick-proof arms (v5.28.0, CR-073): the Buyer\'s picks and the drawn names of each day, small; frozen at the seal, each arm\'s sha256 is in pickproof_days and in the seal line; the nightly export is unconfigured',
  pickproof_picks_history: 'append-only log of every POST of picks (v5.28.0, CR-073): audit_log keeps the call itself; the nightly export is unconfigured',
  rdap_cache: 'shared RDAP cache (v5.29.0, CR-074): definite registry answers only, re-derived by the next lookup; nothing to restore; the nightly export is unconfigured',
  lookup_usage: 'rolling 24-hour log of the bots live RDAP lookups (v5.29.0, CR-074): only the last 24 hours matter, older rows are deleted after 7 days; the nightly export is unconfigured',
  disappearances: 'RDAP tags of closeout names gone before their end and of DISAPPEARED episodes (v5.34.0, BUG-052): re-derivable only while RDAP still shows the state, kept 120 days; the nightly export is unconfigured',
  closeout_expiries: 'RDAP checks of GoDaddy closeout names after their end date (v5.46.0): re-derivable only while RDAP still shows the state, kept 120 days; the unsold rows already written to engine_unsold stay there; the nightly export is unconfigured',
  pickproof_labels: 'T30 labels of the pick-proof arm names (v5.28.0, CR-073): re-derivable from RDAP only while the name is unchanged, otherwise lost; small; the nightly export is unconfigured',
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
