// npm run prefilter -- <folder of the shadow log>
// The daily job (.github/workflows/prefilter.yml): downloads three GoDaddy public files, runs src/prefilter and writes the day's files in the folder.
// It never uses git; the workflow pushes the folder to the branch shadow-log only. Any failure writes nothing and exits 1.
import { spawn } from 'node:child_process';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { normalizeDomain } from '../src/domain-name.js';
import { readFeed, type Feed } from '../src/prefilter/feed.js';
import { createHistory } from '../src/prefilter/history.js';
import { metrics, runPrefilter, type CloseRow, type ShadowRow } from '../src/prefilter/run.js';
import { createWebRisk } from '../src/sources/web-risk.js';
import { loadState } from '../src/state.js';

const BASE = 'https://inventory.auctions.godaddy.com';
const KILLS = 'docs/requests/kills.txt';

const out = process.argv[2];
if (!out || !existsSync(out)) throw new Error('usage: npm run prefilter -- <existing folder of the shadow log>');
const today = new Date().toISOString().slice(0, 10);
if (existsSync(join(out, 'runs', `${today}.json`))) { console.log(`${today} is already logged`); process.exit(0); }

const state = loadState(); // throws on an unreadable or rule-breaking ledger: no run without it
const kills = new Set<string>();
let badKills = 0;
for (const line of readFileSync(KILLS, 'utf8').split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'))) {
  try { kills.add(normalizeDomain(line)); } catch { badKills++; }
}
const readAll = <T>(dir: string): T[] => {
  const d = join(out, dir);
  return existsSync(d) ? readdirSync(d).filter((f) => f.endsWith('.jsonl')).sort().flatMap((f) => readFileSync(join(d, f), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as T)) : [];
};
const logged = readAll<ShadowRow>('shadow');
const closed = readAll<CloseRow>('closes');

const tmp = mkdtempSync(join(tmpdir(), 'prefilter-'));
async function feed(name: string): Promise<Feed> {
  const file = join(tmp, `${name}.zip`);
  const res = await fetch(`${BASE}/${name}.json.zip`, { redirect: 'error', signal: AbortSignal.timeout(10 * 60_000) });
  if (res.status !== 200 || !res.body) throw new Error(`${name}: HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file));
  const unzip = spawn('unzip', ['-p', file], { stdio: ['ignore', 'pipe', 'inherit'] });
  const exit = new Promise<number | null>((resolve, reject) => { unzip.on('close', resolve); unzip.on('error', reject); });
  unzip.stdout.setEncoding('utf8');
  const answer = await readFeed(unzip.stdout as AsyncIterable<string>, Date.now());
  const code = await exit;
  if (code !== 0) throw new Error(`${name}: unzip failed (${code})`);
  rmSync(file);
  return answer;
}

try {
  const auctions = await feed('auctions_ending_tomorrow');
  const endingToday = await feed('auctions_ending_today');
  const closeouts = await feed('closeout_listings');
  const result = await runPrefilter({
    state, now: Date.now, kills, auctions, endingToday, closeouts, logged, closed: new Set(closed.map((c) => `${c.domain} ${c.logged_at}`)),
    webRisk: createWebRisk(process.env.GOOGLE_WEB_RISK_API_KEY?.trim() || null, Date.now), history: createHistory(Date.now, (ms) => new Promise((r) => setTimeout(r, ms))),
  });
  const write = (dir: string, name: string, text: string) => { mkdirSync(join(out, dir), { recursive: true }); writeFileSync(join(out, dir, name), text); };
  const lines = (rows: readonly unknown[]) => rows.map((r) => `${JSON.stringify(r)}\n`).join('');
  write('shadow', `${today}.jsonl`, lines(result.rows));
  write('closes', `${today}.jsonl`, lines(result.closes));
  const summary = { date: today, kills: { read: kills.size, unreadable_lines: badKills }, files: result.summary, killed: result.killed, closes: result.closes.length, totals: metrics([...logged, ...result.rows], [...closed, ...result.closes], state) };
  write('runs', `${today}.json`, `${JSON.stringify(summary, null, 2)}\n`); // last: its presence says the day is complete
  const count = (f: (r: ShadowRow) => string) => result.rows.reduce<Record<string, number>>((n, r) => ({ ...n, [f(r)]: (n[f(r)] ?? 0) + 1 }), {});
  console.log(JSON.stringify({ ...summary, killed: result.killed.length, web_risk: count((r) => r.checks.web_risk.status), history: count((r) => r.checks.history.status) }, null, 2));
} finally {
  rmSync(tmp, { recursive: true, force: true });
}
