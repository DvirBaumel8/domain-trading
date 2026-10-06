// Types shared by the screening run engine (CAP-20) and its checks. A check is a plug-in: Tasks 5-7 add one file each
// under checks/ and register it in checks/index.ts; the engine, the cache, the deadline and resume logic stay as they are.
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { DnsQueryFn } from '../dns/ns-lookup.js';
import type { RdapLookupFn } from '../rdap.js';
import type { CheckService } from '../services/check.js';
import type { Lane } from './form.js';
import type { Lexicon } from './lexicon.js';
import type { CHECK_IDS, SelectionValuesT } from './settings.js';

export type CheckId = (typeof CHECK_IDS)[number];
export type Status = 'PASS' | 'PASS_WITH_NOTE' | 'FLAG' | 'FAIL' | 'UNKNOWN' | 'MANUAL_REQUIRED' | 'NOT_RUN';
export type { Lane };

/** One name of a run, as stored in `screening_runs.input.names` (after normalisation). */
export interface RunItem {
  idx: number;
  domain: string;
  lane: Lane;
  city?: string;
  state?: string;
  trade?: string;
  price_grade?: 'strong' | 'weaker';
  bin_usd?: number;
  leads_ab: number;
  census_list?: string;
  /** ISO time. Live mode: the request time (CR-002 Amendment A2). Full mode: as sent, else absent. Dated inputs use strict `< as_of`. */
  as_of?: string;
  rank?: number;
  /** Set when the name cannot be screened (`DUPLICATE`, `NOT_COM`, `DOMAIN_INVALID`); createRun wrote its `form` FAIL `INPUT_INVALID`. */
  input_error?: string;
}

export interface CheckOutcome {
  status: Status;
  reasonCode: string | null;
  reason: string | null;
  fields: Record<string, unknown>;
  dataAsOf: Date | null;
  evidenceIds: number[];
  upstreamCalls: number;
}

/** A stored result, as the engine, derive.ts and the API see it (ids as numbers). */
export interface ResultRow {
  id: number;
  run_id: string;
  item_idx: number;
  domain: string;
  lane: Lane;
  check_id: CheckId;
  gate: string;
  rule_ids: string[];
  status: Status;
  reason_code: string | null;
  reason: string | null;
  fields: Record<string, unknown>;
  data_as_of: Date | null;
  checked_at: Date;
  settings_label: string;
  list_versions: Record<string, number>;
  duration_ms: number;
  upstream_calls: number;
  evidence_ids: number[];
  source: 'auto' | 'cache' | 'manual';
  cached_from: number | null;
  recorded_by: string | null;
}

export interface RunView {
  id: string;
  mode: 'live' | 'full';
  backtest: boolean;
  buyHold: boolean;
  trancheId: string | null;
  createdAt: Date;
}

/** Outside access for checks: every network and DNS call goes through one of these so tests inject fakes. */
export interface ScreeningDeps {
  fetch: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  checkService: CheckService;
  rdapLookup: RdapLookupFn;
  /** One UDP DNS query to a named server (SURBL goes straight to the zone's own servers, never to a public resolver). */
  dnsQuery: DnsQueryFn;
  /** NS host names of a zone, from the system resolver (only used to discover SURBL's servers). */
  resolveNs: (zone: string) => Promise<string[]>;
  /** IPv4 addresses of a host name (system resolver). */
  resolve4: (host: string) => Promise<string[]>;
}

export interface CheckContext {
  db: Kysely<Database>;
  run: RunView;
  item: RunItem;
  settings: SelectionValuesT;
  settingsLabel: string;
  /** Latest result for this item in this run. */
  latest: (checkId: CheckId) => ResultRow | undefined;
  /** Items ranked ahead of this one that have no gating FAIL so far (CONCENTRATION-1 counts them). */
  ahead: () => { item: RunItem; latest: (c: CheckId) => ResultRow | undefined }[];
  lists: Record<string, { version: number; terms: string[] }>;
  lexicon: Lexicon;
  deps: ScreeningDeps;
  now: () => number;
  /** ms epoch of the run deadline; a long check should stop and return UNKNOWN TIMEOUT when `now() > deadline`. */
  deadline: number;
  /** Per-run memo shared by all items (e.g. the SURBL control result, the portfolio's attributes). */
  shared: Map<string, unknown>;
}

export interface Check {
  id: CheckId;
  gate: string;
  ruleIds: string[];
  /** Names of the `selection_lists` this check reads; their versions are snapshotted into the run. */
  lists: string[];
  run(ctx: CheckContext): Promise<CheckOutcome>;
}

export const outcome = (
  status: Status, reasonCode: string | null, reason: string | null, fields: Record<string, unknown> = {},
  extra: Partial<Pick<CheckOutcome, 'dataAsOf' | 'evidenceIds' | 'upstreamCalls'>> = {},
): CheckOutcome => ({ status, reasonCode, reason, fields, dataAsOf: extra.dataAsOf ?? null, evidenceIds: extra.evidenceIds ?? [], upstreamCalls: extra.upstreamCalls ?? 0 });
