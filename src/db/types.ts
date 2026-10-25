import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** 'YYYY-MM-DD'. pg's date parser is overridden in client.ts so dates never become JS Date. */
export type DateString = string;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>; // insert/update with JSON.stringify(...)

export type Scope = 'read' | 'write' | 'intake' | 'data' | 'visits' | 'bots';
export type Category = 'geo' | 'trend' | 'b2b' | 'collision' | 'regulation' | 'buzzword' | 'other';
export type ListingMode = 'bin' | 'offer' | 'hybrid';
export type DomainStatus = 'pending_purchase' | 'owned' | 'listed' | 'delisted' | 'sold' | 'dropped';
export type RegistrarApi = 'full' | 'manage' | 'none';
export type LedgerType =
  | 'registration' | 'renewal' | 'fee' | 'commission' | 'sale'
  | 'payout_fee' | 'refund' | 'tool' | 'ai' | 'adjustment';
export type PurchaseState = 'created' | 'register_sent' | 'succeeded' | 'failed' | 'unknown';

export interface ApiTokensTable {
  id: Generated<number>;
  name: string;
  scope: Scope;
  token_sha256: string;
  created_at: TimestampDefault;
  revoked_at: Timestamp | null;
  last_used_at: Timestamp | null;
  expires_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
}

export interface SettingsTable {
  id: Generated<boolean>;
  max_domains: Generated<number>;
  /** v5.8.0 (CR-059): the most one S8 name may have cost, and the slots of max_domains reserved for S8. Migration only. */
  s8_max_price_cents: Generated<number>;
  s8_reserved_slots: Generated<number>;
  /** v5.39.0 (CR-077): false = POST /auctions/plans refuses kind "closeout" (CLOSEOUTS_PAUSED). Migration only. */
  s8_closeouts_allowed: Generated<boolean>;
  /** v5.9.0 (CR-060): the S8 default BIN ladder by name length: [{max_len, bin_cents}], last max_len null. Migration only. */
  s8_bin_ladder: Generated<unknown>;
  /** v5.10.0 (CR-061): engine.sales_max_date, the holdout guard. Sales and unsold rows dated after it are rejected. Changed only by POST /engine/holdout-date. */
  engine_sales_max_date: Generated<DateString>;
  /** v5.18.0 (CR-068): visits.enabled. Off until Dvir's line; changed only by POST /visits/settings. */
  visits_enabled: Generated<boolean>;
  /** v5.21.0 (CR-071): the datasave job's settings. Migration only. */
  datasave_godaddy_files: Generated<string[]>;
  datasave_pool_max_price_cents: Generated<number>;
  datasave_pool_keep_days: Generated<number>;
  datasave_raw_keep_days: Generated<number>;
  /** v5.22.0: days the bot-uploaded aftermarket / closed-auction rows and the ended GoDaddy auctions are kept. Migration only. */
  datasave_dynadot_keep_days: Generated<number>;
  datasave_auction_keep_days: Generated<number>;
  /** v5.41.0: the least price (cents) an auction needs to be kept in godaddy_auctions and, when it ended with a bid, to become an engine_sales row. Migration only, >= 100. */
  datasave_auction_min_cents: Generated<number>;
  /** v5.26.0 (CR-072): DIGITS_OR_HYPHEN filter of the closeout candidates (default on). */
  closeouts_filter_digits_hyphen: Generated<boolean>;
  /** v5.28.0 (CR-073): pick-proof settings. Migration only; k can only be raised (trigger) and is at most 300. */
  pickproof_k: Generated<number>;
  pickproof_deadline_hour_utc: Generated<number>;
  pickproof_pool_max_price_cents: Generated<number>;
  pickproof_labels_max_per_run: Generated<number>;
  pickproof_pool_keep_days: Generated<number>;
  /** v5.29.0 (CR-074): TTL of a cached RDAP answer (hours) and the live bot lookups allowed per rolling 24 h. Migration only. */
  lookups_rdap_ttl_hours: Generated<number>;
  lookups_rdap_daily_limit: Generated<number>;
  /** v5.34.0 (BUG-052): RDAP lookups per datasave run for the disappearance tags, and how long tag rows are kept. Migration only. */
  disappearance_lookups_max_per_run: Generated<number>;
  disappearance_keep_days: Generated<number>;
  /** v5.46.0: closeout_expiries: days after the end date of the first RDAP check, days between checks, days after the end date when a still-open name is closed as unknown. Migration only. */
  closeout_expiry_wait_days: Generated<number>;
  closeout_expiry_recheck_days: Generated<number>;
  closeout_expiry_max_days: Generated<number>;
  /** v5.37.0: days the in-range GoDaddy auctions with bids are kept (godaddy_auctions_live) and the fewest bids to keep one. Migration only. */
  datasave_auction_live_keep_days: Generated<number>;
  datasave_auction_live_min_bids: Generated<number>;
  /** v5.45.0 (G-127): the daily auction shortlist: auctions ending within the horizon, list size, names that get the endings check and the automatic pre-bid, days kept. Migration only. */
  shortlist_horizon_hours: Generated<number>;
  shortlist_size: Generated<number>;
  shortlist_endings_n: Generated<number>;
  shortlist_prebid_n: Generated<number>;
  shortlist_expected_resale_cents: Generated<number>;
  shortlist_keep_days: Generated<number>;
  /** v5.18.0: 'requested' (POST /visits/settings {token:'request'}) until the Mac host issues the visit-counter token ('issued'). */
  visits_token_request: Generated<'requested' | 'issued' | null>;
  visits_token_requested_at: Generated<Date | null>;
  visits_token_issued_at: Generated<Date | null>;
  approval_max_age_hours: Generated<number>;
  lander_target: Generated<'afternic' | 'sedo' | 'custom'>;
  allowed_registrars: Generated<string[]>;
  high_value_min_bin_cents: Generated<number>;
  sedo_hybrid_as: Generated<'buy_now' | 'make_offer'>;
  updated_at: TimestampDefault;
}

export type SnapshotSource = 'godaddy_inventory' | 'dynadot_closeouts' | 'dynadot_aftermarket' | 'dynadot_closed_auctions';

/** v5.21.0 (CR-071): one saved file. Complete rows are sealed (trigger snapshot_manifests_guard): only retention may later set raw_available false. */
export interface SnapshotManifestsTable {
  id: Generated<number>;
  source: SnapshotSource;
  data_date: DateString;
  file_name: string;
  bytes: ColumnType<number | null, number | null | undefined, number | null>;
  sha256: ColumnType<string | null, string | null | undefined, string | null>;
  last_modified: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rows: ColumnType<number | null, number | null | undefined, number | null>;
  rows_total: ColumnType<number | null, number | null | undefined, number | null>;
  status: 'complete' | 'partial' | 'error' | 'not_configured';
  http_status: ColumnType<number | null, number | null | undefined, number | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  raw_path: ColumnType<string | null, string | null | undefined, string | null>;
  raw_available: ColumnType<boolean, boolean | undefined, boolean>;
  raw_note: ColumnType<string | null, string | null | undefined, string | null>;
  raw_deleted_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  sealed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: TimestampDefault;
  updated_at: ColumnType<Date, Date | string | undefined, Date | string>;
  /** v5.22.0: 'fetch' (the job) or 'bot_upload' (POST /snapshots/dynadot). */
  origin: ColumnType<'fetch' | 'bot_upload', 'fetch' | 'bot_upload' | undefined, 'fetch' | 'bot_upload'>;
  /** v5.24.0 (CR-071 R-8b): a bot upload's pull coverage (jsonb), null when not sent. */
  coverage: ColumnType<unknown | null, string | null | undefined, string | null>;
}

/** v5.21.0 (CR-071): the parsed closeouts of the last few days. */
export interface DatasavePoolTable {
  data_date: DateString;
  source: string;
  domain: string;
  price_cents: number;
  ends_at: Timestamp;
  score: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  score_reason: ColumnType<string | null, string | null | undefined, string | null>;
  /** v5.26.0 (CR-072): first failed hard filter (null = passed), when the row was processed, the model that scored it. */
  filter_code: ColumnType<string | null, string | null | undefined, string | null>;
  scored_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  model_version: ColumnType<string | null, string | null | undefined, string | null>;
}

/** v5.22.0 (CR-071 R-8, R-9): rows uploaded by the bots (POST /snapshots/dynadot). Unique per listing_id (aftermarket) or per domain (the other kinds), per day. */
export interface DynadotRowsTable {
  id: Generated<number>;
  data_date: DateString;
  kind: 'aftermarket' | 'closed_auctions' | 'closeouts';
  domain: string;
  listing_id: string | null;
  price_cents: number | null;
  bid_count: number | null;
  end_time: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  final_price_cents: number | null;
  ends_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  score: ColumnType<string | null, number | string | null | undefined, number | string | null>;
  score_reason: ColumnType<string | null, string | null | undefined, string | null>;
  filter_code: ColumnType<string | null, string | null | undefined, string | null>;
  scored_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  model_version: ColumnType<string | null, string | null | undefined, string | null>;
}

/** v5.22.0 (CR-071 R-10): a GoDaddy auction that reached $500, followed until it leaves the inventory files. */
export interface GodaddyAuctionsTable {
  id: Generated<number>;
  domain: string;
  end_time: Timestamp;
  auction_type: string | null;
  first_seen: DateString;
  last_seen: DateString;
  last_price_cents: number;
  max_price_cents: number;
  last_bid_count: Generated<number>;
  final_state_at: DateString | null;
  ended: Generated<boolean>;
}

/** v5.37.0: GoDaddy auctions at or under the S8 cap with at least one bid, per data date. */
export interface GodaddyAuctionsLiveTable {
  data_date: DateString;
  domain: string;
  end_time: Timestamp;
  auction_type: string | null;
  price_cents: number;
  bid_count: number;
  domain_age: number | null;
  valuation_cents: number | null;
  pageviews: number | null;
}

/** v5.45.0 (G-127): the best live GoDaddy auctions of a data date, replaced per date by the datasave step auctionShortlist. */
export interface AuctionShortlistTable {
  data_date: DateString;
  domain: string;
  rank: number;
  score: number;
  score_version: string;
  parts: Json;
  price_cents: number;
  bids: number;
  end_time: Timestamp;
  auction_type: string | null;
  valuation_cents: number | null;
  domain_age: number | null;
  pageviews: number | null;
  max_bid_suggested_cents: number;
  reasons: string[];
  prebid_id: number | null;
  prebid_verdict: 'pass' | 'flag' | 'fail' | null;
  dropped_reason: string | null;
  generated_at: Timestamp;
}

export interface DealsTable {
  id: string;
  domain: string | null;
  strategy: string | null;
  status_note: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface DomainsTable {
  id: Generated<number>;
  domain: string;
  deal_id: string | null;
  registrar: string | null;
  status: DomainStatus;
  buy_date: DateString | null;
  cost_cents: number | null;
  expiry_date: DateString | null;
  renewal_price_cents: number | null;
  /** v5.20.0 (BUG-047): where the renewal price came from and its date (POST /portfolio/{domain}/renewal-price). */
  renewal_price_source: string | null;
  renewal_price_as_of: DateString | null;
  renewals_used: Generated<number>;
  /** v5.8.0 (CR-059): NULL = Line 1 (hand registration), 'S8' = Line 2 (imported aftermarket name). */
  lane: 'S8' | null;
  /** v5.44.0: S8 only. RDAP's registrar is the one we imported into (true), another one (false), or unreadable (null). Checked at import and daily until true. */
  transfer_confirmed: boolean | null;
  transfer_checked_at: Date | null;
  drop_date: DateString | null;
  category: Category | null;
  listing_mode: ListingMode | null;
  bin_cents: number | null;
  floor_cents: number | null;
  min_offer_cents: number | null;
  lto_max_months: number | null;
  display_name: string | null;
  lander: string | null;
  lander_ns: string[] | null;
  lander_set_at: Timestamp | null;
  /** True after POST /list with lander "none" and before any lander is chosen (v2.1.0). */
  lander_pending: Generated<boolean>;
  ns_verified_at: Timestamp | null;
  registrar_api: RegistrarApi | null;
  sold_at: Timestamp | null;
  delisted_at: Timestamp | null;
  walkaway_cents: number | null;
  price_grade: 'strong' | 'weaker' | null;
  pricing_source: 'formula' | 'approved_exception' | null;
  pricing_settings_version: number | null;
  first_listed_at: Timestamp | null;
  pricing_hold: Generated<boolean>;
  pricing_hold_reason: string | null;
  plan_id: string | null;
  plan_audit_id: string | null;
  export_pending_since: Timestamp | null;
  listing_changed_at: Timestamp | null;
  /** v4.0.0 (CR-045/048): evergreen | trend | regulation; a trend or regulation name carries a sell-or-drop date. */
  horizon: Generated<'evergreen' | 'trend' | 'regulation'>;
  sell_or_drop_by: DateString | null;
  /** v4.0.0 (CR-045 item 3): the group of the 40-name test, from the screening verdicts at buy. */
  screening_group: 'passed' | 'borderline' | null;
  /** v4.0.0 (CR-046 item 3): STRe, its reason and the renewal maths at buy. */
  buy_card: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface LedgerEntriesTable {
  id: Generated<number>;
  occurred_on: DateString;
  domain_id: number | null;
  deal_id: string | null;
  type: LedgerType;
  amount_cents: number;
  currency: Generated<'USD'>;
  counterparty: string | null;
  receipt_ref: string | null;
  note: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ListingHistoryTable {
  id: Generated<number>;
  domain_id: number;
  at: TimestampDefault;
  source: 'buy' | 'import' | 'list' | 'schedule';
  category: Category | null;
  mode: ListingMode | null;
  bin_cents: number | null;
  floor_cents: number | null;
  min_offer_cents: number | null;
  lto_max_months: number | null;
  lander: string | null;
  override: Generated<boolean>;
  override_reason: string | null;
  approval_text: string | null;
  approval_at: Timestamp | null;
  audit_id: string | null;
  price_grade: 'strong' | 'weaker' | null;
  walkaway_cents: number | null;
  pricing_source: 'formula' | 'approved_exception' | null;
  pricing_settings_version: number | null;
  schedule_event_id: number | null;
  plan_audit_id: string | null;
}

export interface RegistrarPresenceTable {
  domain_id: number;
  status: 'present' | 'absent';
  first_absent_at: Date | null;
  last_checked_at: Date;
}

export interface SalesTable {
  id: Generated<number>;
  domain_id: number;
  sale_ledger_id: number;
  venue: string;
  transaction_ref: string | null;
  sale_price_cents: number;
  commission_cents: number;
  other_fees_cents: Generated<number>;
  sold_at: Timestamp;
  offer_id: number | null;
  evidence_source: 'afternic_email' | 'sedo_email' | 'afternic_dashboard' | 'sedo_dashboard' | 'escrow' | 'other' | null;
  evidence_ref: string | null;
  approval_text: string | null;
  approval_at: Timestamp | null;
  recorded_by: string;
  confirmed: Generated<boolean>;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface OffersTable {
  id: Generated<number>;
  domain_id: number;
  amount_cents: number;
  source: 'afternic' | 'godaddy' | 'sedo' | 'domainagents' | 'email_inbound' | 'outbound_reply' | 'other';
  received_at: Timestamp;
  buyer_type: Generated<'end_user' | 'investor' | 'broker' | 'unknown'>;
  buyer_ref: string | null;
  external_ref: string | null;
  bin_cents_at: number | null;
  floor_cents_at: number | null;
  walkaway_cents_at: number | null;
  min_offer_cents_at: number | null;
  listing_history_id: number | null;
  band: 'below_min' | 'below_walkaway' | 'mid_range' | 'at_or_above_floor' | 'at_or_above_bin' | 'geo_below_bin' | 'unpriced';
  routing: 'auto_decline' | 'dvir' | 'auto_accept' | 'accept_preapproved';
  outcome: 'declined_auto' | 'open' | 'declined' | 'countered' | 'accepted' | 'expired' | 'withdrawn' | 'sold';
  outcome_at: Timestamp | null;
  outcome_note: string | null;
  outcome_approval_text: string | null;
  note: string | null;
  recorded_by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface QuotesTable {
  id: Generated<number>;
  check_id: string;
  domain: string;
  registrar: string;
  quoted_at: TimestampDefault;
  available: boolean | null;
  premium: boolean | null;
  first_year_cents: number | null;
  renewal_cents: number | null;
  privacy_cents_per_year: number | null;
  two_year_cents: number | null;
  eligible: boolean;
  exclusion_reason: string | null;
  raw: Json | null;
}

export interface PurchasesTable {
  id: Generated<number>;
  idempotency_key: string;
  request_hash: string;
  domain: string;
  state: PurchaseState;
  dry_run: Generated<boolean>;
  registrar: string | null;
  check_id: string | null;
  charged_cents: number | null;
  order_id: string | null;
  max_price_cents: number;
  approval_text: string;
  approval_at: Timestamp;
  response: Json | null;
  expected_cents: number | null;
  request: Json | null;
  audit_id: string | null;
  tranche_id: string | null;
  small_buy_exception: Generated<boolean>;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface ReceiptsTable {
  id: Generated<number>;
  purchase_id: number | null;
  registrar: string;
  order_id: string;
  raw: Json | null;
  fetched_at: TimestampDefault;
}

export interface AuditLogTable {
  id: string;
  at: TimestampDefault;
  token_id: number | null;
  scope: Scope | 'admin' | 'job' | null;
  method: string;
  path: string;
  idempotency_key: string | null;
  approval_text: string | null;
  approval_at: Timestamp | null;
  request: Json | null;
  status_code: number;
  result_summary: string | null;
  client_ip: string | null;
  /** v5.20.0 (CR-069): the optional X-Bot-Name header; logged, not a security check. */
  bot_name: string | null;
}

export interface IdempotencyKeysTable {
  key: string;
  request_hash: string;
  method: string;
  path: string;
  token_id: number | null;
  state: 'in_progress' | 'completed';
  status_code: number | null;
  response_body: string | null;
  response_content_type: string | null;
  created_at: TimestampDefault;
  completed_at: Timestamp | null;
}

export interface ExportRunsTable {
  id: Generated<number>;
  marketplace: 'afternic' | 'sedo';
  at: TimestampDefault;
  domains: string[];
  export_id: string;
}

export interface ExportUploadsTable {
  id: Generated<number>;
  venue: 'afternic' | 'sedo';
  export_id: string;
  domains: string[];
  uploaded_at: Timestamp;
  approval_text: string | null;
  note: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface JobRunsTable {
  id: Generated<number>;
  job: 'tick' | 'daily' | 'screen' | 'train' | 'datasave';
  trigger: 'scheduled' | 'manual' | 'cli';
  scheduled_for: ColumnType<Date | null, Date | string | null, Date | string | null>;
  started_at: Timestamp;
  finished_at: Timestamp;
  skipped: boolean;
  ok: boolean;
  steps: Json;
  /** The WRITE token's name for a manual run started through the API; null for the job token, the Worker and the CLI. */
  triggered_by: ColumnType<string | null, string | null | undefined, never>;
  /** The queue run (job_queue_runs.id) this record closes; null for a run made by the direct runner (CLI) and for runs before 3.0.0. */
  queue_run_id: ColumnType<string | null, string | null | undefined, never>;
}

/** An enqueued job run (v3.0.0). Written once at enqueue; its progress lives in job_steps and its result in job_runs. */
export interface JobQueueRunsTable {
  id: string;
  job: 'tick' | 'daily' | 'screen' | 'train' | 'datasave';
  trigger: 'scheduled' | 'manual' | 'cli';
  scheduled_for: ColumnType<Date | null, Date | string | null | undefined, never>;
  triggered_by: ColumnType<string | null, string | null | undefined, never>;
  /** v3.3.0: the run's request (`screen`: {max_names}); null for tick and daily. */
  params: ColumnType<unknown, string | null | undefined, never>;
  /** v5.21.0 (CR-071): the worker takes no step of the run before this time (the datasave retry). */
  not_before: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: TimestampDefault;
}

export type JobStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** One step of a queued run (v3.0.0); status only moves forward (trigger job_steps_guard). */
export interface JobStepsTable {
  id: Generated<number>;
  run_id: string;
  job: 'tick' | 'daily' | 'screen' | 'train' | 'datasave';
  step: string;
  position: number;
  status: Generated<JobStepStatus>;
  attempt: Generated<number>;
  max_attempts: number;
  timeout_ms: number;
  locked_by: ColumnType<string | null, string | null | undefined, string | null>;
  locked_until: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  started_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  finished_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  ms: ColumnType<number | null, number | null | undefined, number | null>;
  summary: ColumnType<unknown, string | null | undefined, string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  created_at: TimestampDefault;
}

export interface ApiUsageTable {
  source: string;
  month: string;
  calls: Generated<number>;
}

export interface RegistrarStateChecksTable {
  id: Generated<number>;
  domain: string;
  checked_at: TimestampDefault;
  auto_renew: boolean | null;
  privacy: boolean | null;
  ns: string[] | null;
}

export interface VenueListingsTable {
  id: Generated<number>;
  domain: string;
  venue: 'afternic' | 'sedo';
  listed_at: Timestamp;
  delisted: ColumnType<boolean, boolean | undefined, never>;
  mode: string;
  price_cents: number | null;
  min_offer_cents: number | null;
  evidence: ColumnType<Record<string, unknown> | null, string | null | undefined, never>;
  note: string | null;
  token_name: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
  provenance: ColumnType<'ours_confirmed' | 'observed_public' | 'unknown', 'ours_confirmed' | 'observed_public' | 'unknown' | undefined, never>;
  seen_price_cents: number | null;
  seen_url: string | null;
  seen_at: Timestamp | null;
}

export interface PortfolioStatsTable {
  id: Generated<number>;
  domain: string;
  as_of: DateString;
  month: string;
  venue: Generated<'afternic' | 'sedo' | 'sellerhub'>;
  views: number | null;
  leads: number | null;
  inquiries: number | null;
  offers: number | null;
  source: string;
  token_name: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface OutreachEmailsTable {
  id: Generated<number>;
  domain: string;
  recipient_domain: string;
  sent_at: Timestamp;
  reply: Generated<boolean>;
  outcome: 'interested' | 'declined' | 'offer' | 'sold' | 'bounced' | 'other' | null;
  token_name: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface HoldoutTable {
  id: Generated<number>;
  month: string;
  domain: string;
  grp: 'passed' | 'failed';
  run_id: string | null;
  seed: string;
  picked_at: TimestampDefault;
  lookalikes_at_pick: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  recheck_at: Timestamp | null;
  lookalikes_recheck: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
  delta: ColumnType<Record<string, unknown> | null, string | null | undefined, string | null>;
}

export interface ScoutLessonsTable {
  id: string;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
  scout: string;
  sector: string;
  domains: string[];
  rule: string;
  lesson: string;
  notes: ColumnType<unknown, string | undefined, string>;
  recheck_if: string;
  source_file: string | null;
  superseded_by: string | null;
  created_by: string;
}

export interface SalesPatternUploadsTable {
  id: Generated<number>;
  uploaded_at: TimestampDefault;
  rows_n: number;
  token_name: string | null;
  audit_id: string | null;
}

export interface SalesPatternRowsTable {
  id: Generated<number>;
  upload_id: number;
  domain: string;
  price_cents: number;
  sold_on: DateString;
  venue: string | null;
}

export interface KeywordDemandUploadsTable {
  id: Generated<number>;
  uploaded_at: Timestamp;
  title_line: string | null;
  date_range_line: string | null;
  location: string | null;
  month: string | null;
  rows_n: number;
  skipped_n: Generated<number>;
  recorded_by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface KeywordDemandTable {
  id: Generated<number>;
  upload_id: number;
  keyword: string;
  avg_monthly_searches: number | null;
  competition_index: number | null;
  three_month_change: string | null;
  yoy_change: string | null;
}

export interface EngineUploadsTable {
  id: Generated<number>;
  kind: 'sales' | 'unsold';
  received_n: number;
  accepted_n: number;
  duplicate_n: number;
  rejected_n: number;
  rejects: Json;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface EngineSalesTable {
  id: Generated<number>;
  domain: string;
  price_cents: number;
  sale_date: DateString;
  venue: string;
  source: string;
  source_url: string | null;
  upload_id: number;
  created_at: TimestampDefault;
}

export interface DomainRdapTable {
  id: Generated<number>;
  host: string;
  created: Timestamp | null;
  expires: Timestamp | null;
  registrar: string | null;
  reg: boolean;
  checked_at: Timestamp;
  loaded_at: TimestampDefault;
}

export interface LiveChecksTable {
  id: Generated<number>;
  host: string;
  source: 'live' | 'livefail' | 'cc';
  label: string | null;
  park: string | null;
  checked_at: Timestamp;
  value_json: Json | null;
  loaded_at: TimestampDefault;
}

/** tm_kills (term) and bigco_names (name) share every other column; both append-only. */
export interface TmKillsTable {
  id: Generated<number>;
  term: string;
  reason: string | null;
  source: string | null;
  raw: Json | null;
  supersedes: number | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface BigcoNamesTable {
  id: Generated<number>;
  name: string;
  reason: string | null;
  source: string | null;
  raw: Json | null;
  supersedes: number | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

/** v5.18.0 (CR-068): daily visitor counts per domain and source; aggregates only. */
export interface VisitDailyTable {
  id: Generated<number>;
  domain: string;
  date_utc: DateString;
  source: 'dom_redirect' | 'afternic';
  human_hits: Generated<number>;
  bot_hits: Generated<number>;
  capped: Generated<number>;
  referrer_hosts: ColumnType<Record<string, number>, string | undefined, string>;
  views_30d: number | null;
  leads_30d: number | null;
  imported_at: Timestamp | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

/** v5.18.0 (CR-068): the URL forward POST /visits/forward set at the registrar (active while reverted_at is null). */
export interface VisitForwardsTable {
  id: Generated<number>;
  domain: string;
  target: string;
  before_forwards: ColumnType<unknown, string | undefined, string>;
  set_at: Timestamp;
  reverted_at: Timestamp | null;
}

export interface SalesCompsTable {
  id: Generated<number>;
  domain: string;
  sale_date: DateString;
  price_cents: number;
  tier: 'T1' | 'T2' | 'T3' | 'T4';
  year_flag: string | null;
  sale_year: number;
  reg_date_at_sale: string | null;
  net_reg_at_sale: string | null;
  org_reg_at_sale: string | null;
  source_url: string | null;
  dup_sources: string | null;
  engine_sale_id: number | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface EngineUnsoldTable {
  id: Generated<number>;
  domain: string;
  type: 'dropped_after_held' | 'registered_unsold';
  observation_date: DateString;
  caught_by_catcher: boolean | null;
  upload_id: number;
  created_at: TimestampDefault;
}

export interface EngineEndingsTable {
  id: Generated<number>;
  name: string;
  tld: 'net' | 'co' | 'org' | 'io' | 'ai' | 'com';
  registered: boolean | null;
  created_at_registry: Timestamp | null;
  checked_at: Timestamp;
  http_status: number | null;
  reason_code: string | null;
  evidence: Json | null;
  /** v5.7.0: the registrar entity's name from the RDAP answer, null when the registry gives none. */
  registrar: string | null;
}

/** v5.7.0 (CR-058): append-only baseline and change log of the other endings of owned names. */
export interface OwnedEndingEventsTable {
  id: Generated<number>;
  domain: string;
  tld: 'net' | 'co' | 'org' | 'io' | 'ai';
  kind: 'baseline' | 'newly_registered' | 're_registered';
  registered: boolean;
  created_at_registry: Timestamp | null;
  registrar: string | null;
  ending_id: number | null;
  created_at: TimestampDefault;
}

export interface EngineModelsTable {
  n: Generated<number>;
  id: ColumnType<string, undefined, never>;
  created_at: TimestampDefault;
  finished_at: Generated<Date | null>;
  status: Generated<'running' | 'done' | 'failed'>;
  error: Generated<string | null>;
  trained_by: string;
  audit_id: Generated<string | null>;
  queue_run_id: Generated<string | null>;
  dataset: ColumnType<unknown, string | null | undefined, string | null>;
  test_sha256: Generated<string | null>;
  params: ColumnType<unknown, string | null | undefined, string | null>;
  metrics: ColumnType<unknown, string | null | undefined, string | null>;
  chosen_weighting: Generated<'unweighted' | 'half_life_12m' | null>;
  feature_list: ColumnType<unknown, string | null | undefined, string | null>;
  test_rows: ColumnType<unknown, string | null | undefined, string | null>;
}

export interface SiblingScansTable {
  id: Generated<number>;
  domain: string;
  fetched_at: Timestamp;
  settings_label: string;
  siblings: Json;
  lead_points: Json;
  complete: boolean;
  skipped_n: Generated<number>;
  upstream_calls: number;
  evidence_ids: Json;
  recorded_by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ListingSyncLogTable {
  id: Generated<number>;
  domain: string;
  venue: 'sellerhub';
  action: 'create' | 'update' | 'delete' | 'sold_seen' | 'error';
  bin_cents: number | null;
  min_offer_cents: number | null;
  http_status: number | null;
  detail: string | null;
  at: TimestampDefault;
}

export interface PortfolioChecksTable {
  id: Generated<number>;
  domain_id: number;
  at: TimestampDefault;
  kind: 'registry' | 'web' | 'blocklist' | 'price' | 'lookalikes';
  status: 'ok' | 'fail' | 'unknown';
  details: ColumnType<Record<string, unknown>, string | undefined, never>;
}

export interface PricingSettingsTable {
  version: number;
  effective_at: Timestamp;
  created_at: TimestampDefault;
  approval_text: string;
  approval_at: Timestamp;
  note: string | null;
  geo_bin_strong_cents: number;
  geo_bin_weaker_cents: number;
  geo_bin_min_cents: number;
  geo_bin_max_cents: number;
  geo_drops_enabled: boolean;
  geo_drops: Json;
  floor_bps: number;
  floor_min_cents: number;
  walkaway_bps: number;
  walkaway_min_cents: number;
  hybrid_min_offer_cents: number;
  drops: Json;
  final_push_days_before_drop: number;
  final_push_mode: 'bin_to_floor_ceil95' | 'bin_to_lowest_listed_ge_floor';
  delist_days_before_drop: number;
  headsup_days_before: number;
  comps_min: number;
  comps_max: number;
  public_lto: boolean;
  allowed_bins_cents: number[] | null;
  nongeo_bin_min_cents: number | null;
  nongeo_default_bin_cents: number | null;
  lander_exception_bins_cents: number[];
  floor_rounding: 'round5' | 'dollar';
  drop_mode: 'pct' | 'ladder';
}

export type PriceScheduleEvent = 'drop1_m6' | 'drop2_m18' | 'geo_drop_m12' | 'final_push' | 'delist';
export type PriceScheduleStatus =
  | 'planned' | 'applied' | 'skipped_at_minimum' | 'skipped_no_change' | 'skipped_disabled'
  | 'superseded' | 'superseded_by_final_push' | 'cancelled' | 'failed';

export interface PriceScheduleTable {
  id: Generated<number>;
  domain_id: number;
  plan_id: string;
  event: PriceScheduleEvent;
  due_on: DateString;
  bin_cents: number | null;
  floor_cents: number | null;
  walkaway_cents: number | null;
  settings_version: number;
  status: PriceScheduleStatus;
  applied_at: Timestamp | null;
  listing_history_id: number | null;
  note: string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface PricingEvidenceTable {
  id: Generated<number>;
  domain_id: number;
  comps: Json | null;
  rationale: string | null;
  legacy_no_comps_reason: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface SelectionSettingsTable {
  id: Generated<number>;
  label: string;
  values: Json;
  based_on_id: number | null;
  note: string | null;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
  // Set once, when the version is activated (controller ruling R4: columns, not a table). Active = highest activation_seq.
  activation_seq: number | null;
  activated_at: Date | null;
  activation_approval_text: string | null;
  activation_approval_at: Date | null;
  activated_by: string | null;
  activation_audit_id: string | null;
}

export interface SelectionListsTable {
  id: Generated<number>;
  name: string;
  version: number;
  terms: string[];
  note: string | null;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
  /** Dvir's words for a frozen census list; null for the other lists. */
  approval_text: string | null;
}

export interface CandidateIntakeTable {
  id: Generated<string>;
  domain: string;
  lane: 'S2' | 'S3' | 'S4' | 'S6' | 'S7';
  source: string;
  note: string | null;
  comps: Json | null;
  received_at: TimestampDefault;
  token_name: string;
  audit_id: string | null;
  status: 'queued' | 'duplicate' | 'removed';
  reason: string | null;
  who_chases: string | null;
  /** v3.3.0 (CR-023 B): [{name, url}] the scout lists as firms already selling the service; null = none sent. */
  sellers: Json | null;
  /** v3.3.0 (CR-022 A): the scout's word pieces for the name; null = the dictionary split decided. */
  words: ColumnType<string[] | null, string[] | null | undefined, never>;
  /** v3.10.0 (CR-043): the resolved topic (the scout's, else `<lane>:<first two content tokens>`), lower-case, at most 60 characters; null = none. */
  topic: string | null;
}
export interface CandidateScreeningsTable {
  id: Generated<string>;
  intake_id: string | null;
  domain: string;
  origin: 'intake' | 'drop_list';
  run_id: string;
  day: DateString;
  at: TimestampDefault;
  /** v3.3.0 (CR-021): screened by POST /candidates/screen (counts toward its own allowance, not the daily run's). */
  on_demand: Generated<boolean>;
}
export interface DailyCandidateListsTable {
  id: Generated<string>;
  day: DateString;
  built_at: TimestampDefault;
  entries: Json;
  sections: Json;
  summary: Json;
  built_by: Generated<'daily' | 'rebuild' | 'auto'>;
}
export interface DomainRecordsTable {
  id: Generated<string>;
  domain: string;
  kind: 'tm_us' | 'history' | 'sellers';
  record: unknown;
  checked_by: string;
  checked_at: Timestamp;
  evidence_url: string | null;
  note: string | null;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
  source_run_id: string | null;
}

export interface SiblingMethodApprovalsTable {
  id: Generated<string>;
  method: string;
  pools_sha256: string;
  approval_text: string;
  approval_at: Timestamp;
  audit_id: string | null;
  created_by: string | null;
  at: TimestampDefault;
}

export interface ScreeningEvidenceTable {
  id: Generated<string>;
  source: string;
  url: string;
  retrieved_at: Timestamp;
  http_status: number | null;
  sha256: string;
  content_type: string | null;
  text_gz: Buffer | null;
  text_bytes: number;
  truncated: boolean;
  created_at: TimestampDefault;
}

export interface ScreeningRunsTable {
  id: string;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
  mode: 'live' | 'full';
  backtest: boolean;
  settings_id: number;
  settings_label: string;
  buy_hold: boolean;
  tranche_id: string | null;
  input: Json;
  gate_plan: Json;
  list_versions: Json;
  status: 'running' | 'done' | 'partial' | 'cancelled';
  cancelled_at: Date | null;
  cancelled_by: string | null;
  /** v5.13.0: the `reason` of the cancel call (at most 200 characters), else null. */
  cancel_reason: string | null;
  deadline_at: Timestamp;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  summary: Json | null;
}

export interface ScreeningResultsTable {
  id: Generated<string>;
  run_id: string;
  item_idx: number;
  domain: string;
  lane: string;
  check_id: string;
  gate: string;
  rule_ids: string[];
  status: 'PASS' | 'PASS_WITH_NOTE' | 'FLAG' | 'FAIL' | 'UNKNOWN' | 'MANUAL_REQUIRED' | 'NOT_RUN';
  reason_code: string | null;
  reason: string | null;
  fields: Json;
  data_as_of: Date | null;
  checked_at: Timestamp;
  settings_label: string;
  list_versions: Json;
  duration_ms: number;
  upstream_calls: number;
  evidence_ids: Generated<string[]>;
  source: 'auto' | 'cache' | 'manual';
  cached_from: string | null;
  /** Hash of `inputs` (0 for a check without dependencies): one automatic row per (run, item, check, generation). */
  generation: Generated<string>;
  /** The dependency row ids this row was computed from (see ResultRow.inputs). */
  inputs: Json | null;
  recorded_by: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ScreeningPacksTable {
  id: string;
  domain: string;
  version: number;
  run_id: string;
  item_idx: number;
  status: 'complete' | 'incomplete';
  missing: Json;
  content: Json;
  content_sha256: string;
  settings_label: string;
  issued_at: Timestamp;
  issued_by: string;
  audit_id: string | null;
}

export interface ScreeningVerdictsTable {
  id: Generated<string>;
  run_id: string;
  item_idx: number;
  domain: string;
  check_id: string;
  result_id: string;
  verdict: 'PASS' | 'REJECT';
  reason: string;
  decided_by: string;
  decided_at: Timestamp;
  recorded_by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface TranchesTable {
  id: string;
  name: string;
  status: 'open' | 'closed';
  opened_at: TimestampDefault;
  opened_by: string;
  closed_at: Date | null;
  closed_by: string | null;
  settings_label: string;
  close_report: Json | null;
  audit_id: string | null;
}

export interface TrancheMembersTable {
  id: Generated<string>;
  tranche_id: string;
  domain: string;
  lane: string;
  is_geo: boolean;
  main_lane: boolean;
  run_id: string;
  added_at: TimestampDefault;
  added_by: string;
  removed_at: Date | null;
  removed_by: string | null;
}

export interface LabelledNamesTable {
  domain: string;
  role: 'fit' | 'dev' | 'test';
  label: 'sold' | 'dropped';
  source: string;
  slice: string;
  report_lane: 'expired' | 'fresh' | 'aged' | 'geo' | null;
  price_cents: number | null;
  as_of: DateString | null;
  features: Json;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
}

export interface HoldoutSuitesTable {
  id: Generated<number>;
  suite: string;
  version: number;
  slices: string[] | null;
  sources: string[] | null;
  member_hash: string;
  member_count: number;
  cell: string;
  created_at: TimestampDefault;
  created_by: string;
  approval_text: string;
  approval_at: Date;
  audit_id: string | null;
  /** v2.5.0: NULL (rows before it) reads as none / false. */
  gates_not_assessed: string[] | null;
  clears_hold: boolean | null;
}

export interface TestSetsTable {
  name: string;
  purpose: 'new' | 'rescore';
  settings_label: string | null;
  seed: string | null;
  test_share: string | null;
  filters: Json;
  run_id: string;
  created_at: TimestampDefault;
  created_by: string;
  status: 'computing' | 'ready' | 'sealed' | 'cancelled';
  sealed_at: Date | null;
  member_count: number | null;
  member_hash: string | null;
  sibling_method: 'bt1@v1' | 'bt1@v2' | 'bt1@v3' | null;
  features_as_of: 'row' | 'now' | null;
  /** v2.7.0: NULL (sets before it) reads as 7. */
  max_answer_age_days: number | null;
}

export interface TestSetRowsTable {
  id: Generated<string>;
  set_name: string;
  domain: string;
  label: 'sold' | 'dropped';
  as_of: DateString;
  source: string;
  price_usd: string | null;
  report_lane: 'expired' | 'fresh' | 'aged' | 'geo' | null;
  role: 'test' | 'dev' | null;
  kept: boolean;
  reason: string | null;
}

/** v2.8.0 (CR-007 §22 G-2): an uploaded drop list, its rows (kept or removed with a reason) and the daily registry checks of the kept ones. All append-only. */
export interface DropListsTable {
  name: string;
  list_date: DateString;
  created_at: TimestampDefault;
  created_by: string;
  received_n: number;
  kept_n: number;
}
export interface DropListRowsTable {
  id: Generated<number>;
  list_name: string;
  domain: string;
  kept: boolean;
  reason: string | null;
  tokens: string[] | null;
}
export interface DropListChecksTable {
  id: Generated<number>;
  list_name: string;
  domain: string;
  checked_at: Timestamp;
  status: 'pending_delete' | 'redemption' | 'registered' | 'not_registered' | 'unknown';
  last_changed: DateString | null;
  expected_drop_date: DateString | null;
  drop_date_source: 'rdap_last_changed' | 'estimate' | null;
  reason_code: string | null;
}

/** v2.8.0 (G-1): a cohort of names for the forward test. Only `status` computing -> frozen may change (trigger). */
export interface CohortsTable {
  name: string;
  created_at: TimestampDefault;
  created_by: string;
  settings_labels: string[];
  source: Json;
  run_id: string;
  status: 'computing' | 'frozen' | 'abandoned';
}
export interface CohortNamesTable {
  id: Generated<number>;
  cohort: string;
  domain: string;
  expected_drop_date: DateString | null;
  source: string | null;
  included: boolean;
  reason: string | null;
}
export interface CohortDecisionsTable {
  id: Generated<number>;
  cohort: string;
  domain: string;
  settings_label: string;
  decision: 'accept' | 'reject' | 'undecided';
  tier: string | null;
  decided_at: Timestamp;
  late: boolean;
}
export interface CohortOutcomesTable {
  id: Generated<number>;
  cohort: string;
  domain: string;
  kind: 'drop' | 'rereg30' | 'rereg60' | 'rereg90';
  checked_at: Timestamp;
  result: 'available_after_drop' | 'caught_at_drop' | 'restored' | 'still_pending' | 'unknown' | 'yes' | 'no';
  created_at_registry: Date | null;
  registrar: string | null;
  reason_code: string | null;
}

// v2.10.0 (CR-011 part B)
export interface CompanyDocumentsTable {
  version: Generated<number>;
  sha256: string;
  text: string;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
}
export interface ForbiddenTermsTable {
  id: Generated<number>;
  term: string;
  category: Generated<'listed_term'>;
  created_at: TimestampDefault;
  created_by: string;
}
export interface ForbiddenTermRetirementsTable {
  id: Generated<number>;
  term_id: number;
  at: TimestampDefault;
  by: string;
  audit_id: string | null;
  reason: string | null;
}
export interface ReviewPacketsTable {
  id: string;
  created_at: TimestampDefault;
  created_by: string;
  kind: 'daily' | 'weekly';
  document_version: number;
  content: Json;
  sha256: string;
}
export interface ReviewFeedbackTable {
  id: Generated<number>;
  packet_id: string;
  created_at: TimestampDefault;
  created_by: string;
  status: 'ok' | 'unknown';
  provider: string;
  model: string | null;
  cost_usd: ColumnType<string, number | string | undefined, never>;
  reason: string | null;
  attempts: number | null;
}
export interface ReviewItemsTable {
  id: Generated<number>;
  packet_id: string;
  created_at: TimestampDefault;
  category: string;
  severity: 'low' | 'medium' | 'high';
  text: string;
  novelty: 'new' | 'repeat';
  repeats_item_id: number | null;
}
export interface ReviewItemStatusesTable {
  id: Generated<number>;
  item_id: number;
  status: 'acted' | 'rejected' | 'watching';
  note: string;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
}

export interface ReviewSettingsChangesTable {
  id: Generated<number>;
  at: TimestampDefault;
  by: string;
  audit_id: string | null;
  enabled: boolean;
  model: string;
  tier: 'free' | 'paid';
  note: string | null;
  old: unknown;
}

export interface ReviewRetriesTable {
  id: Generated<number>;
  packet_id: string;
  day: string;
  created_at: TimestampDefault;
}

export interface ReplayRunsTable {
  id: string;
  suite: string;
  mode: 'diagnostic' | 'holdout';
  settings_id: number;
  settings_label: string;
  suite_def_id: number | null;
  filter: Json;
  report: Json;
  leakage_rows: number;
  pass: boolean;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
}

export interface RdapLookupsTable {
  id: Generated<string>;
  domain: string;
  outcome: 'registered' | 'not_registered' | 'unknown';
  reason_code: string | null;
  http_status: number | null;
  facts: unknown | null;
  evidence_id: string | null;
  checked_at: Timestamp;
  /** v2.9.0: the RDAP host that answered (verisign_rdap or a hostname); NULL before v2.9.0. */
  source: string | null;
}

/** v5.29.0 (CR-074): the shared RDAP cache; definite answers only (never an error). */
export interface RdapCacheTable {
  domain: string;
  registered: boolean | null;
  created: ColumnType<Date | null, Date | string | null, Date | string | null>;
  expires: ColumnType<Date | null, Date | string | null, Date | string | null>;
  registrar: string | null;
  statuses: Generated<string[]>;
  nameservers: Generated<string[]>;
  updated_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
  checked_at: Timestamp;
  reason_code: string | null;
}
/** v5.34.0 (BUG-052): one row per closeout name gone before its ends_at, or per DISAPPEARED market episode, with its RDAP tag. */
export interface DisappearancesTable {
  source: 'godaddy_closeouts' | 'dynadot_closeouts' | 'market_episode';
  domain: string;
  gone_date: DateString;
  prev_date: DateString;
  ends_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  episode_id: ColumnType<string | null, string | null | undefined, string | null>;
  baseline_registrar: ColumnType<string | null, string | null | undefined, string | null>;
  baseline_source: ColumnType<'rdap_cache' | 'feed' | null, 'rdap_cache' | 'feed' | null | undefined, 'rdap_cache' | 'feed' | null>;
  tag: Generated<'bought' | 'deleted' | 'unknown'>;
  tag_reason: Generated<string>;
  final: Generated<boolean>;
  attempts: Generated<number>;
  first_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rdap_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rdap_registrar: ColumnType<string | null, string | null | undefined, string | null>;
  rdap_statuses: ColumnType<string[] | null, string | null | undefined, string | null>;
  rdap_created: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Date>;
}
/** v5.46.0: a GoDaddy closeout name that reached its end date on the list; RDAP decides afterwards whether it dropped unsold. Rules: docs/internal/closeouts.md "Closeout expiries". */
export interface CloseoutExpiriesTable {
  domain: string;
  ends_at: Timestamp;
  ends_on: DateString;
  first_seen_on: DateString;
  tag: Generated<'pending' | 'dropped' | 'held' | 'unknown'>;
  tag_reason: ColumnType<string | null, string | null | undefined, string | null>;
  caught: ColumnType<boolean | null, boolean | null | undefined, boolean | null>;
  attempts: Generated<number>;
  rdap_checked_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rdap_registrar: ColumnType<string | null, string | null | undefined, string | null>;
  rdap_statuses: ColumnType<string[] | null, string | null | undefined, string | null>;
  rdap_created: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  rdap_expires: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  final: Generated<boolean>;
  fed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_at: Generated<Date>;
}
export interface LookupUsageTable {
  id: Generated<string>;
  source: 'rdap';
  at: Timestamp;
  by_token: string;
}

export interface ReferenceFilesTable {
  id: Generated<string>;
  name: string;
  source_url: string;
  fetched_at: Timestamp;
  data_date: ColumnType<Date | string | null, string | null, string | null>;
  sha256: string;
  bytes: number;
  body_gz: Buffer | null;
  same_as_id: string | null;
}

export interface NamebioKeywordStatsTable {
  keyword: string;
  placements: Json;
  source: string;
  source_url: string;
  fetched_at: Timestamp;
}
export interface NamebioCallsTable {
  id: Generated<string>;
  kind: 'retailstats' | 'tldstats' | 'verisign' | 'verisign_file';
  called_at: Timestamp;
}

export interface ManualQuotesTable {
  id: Generated<string>;
  domain: string;
  registrar: string;
  renewal_cents: number;
  first_year_cents: number | null;
  source_url: string | null;
  source_note: string;
  observed_at: Timestamp;
  recorded_by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

/** v5.23.0 (CR-075): add-only sale reports (POST /data/sales). */
export interface MarketSalesTable {
  id: Generated<number>;
  name: string;
  venue: string;
  sale_price_cents: number;
  sale_date: DateString;
  source: string;
  source_url: string | null;
  tier: 'A' | 'B' | 'C' | 'D';
  listing_type: Generated<'bin' | 'offer' | 'auction' | 'closeout'>;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}

// ---- v5.43.0 (CR-078): the knowledge base. Append-only except kb_loads; a correction is the next `version` with `supersedes` = the replaced row.
export interface KbSettingsTable {
  version: number;
  created_at: TimestampDefault;
  note: string | null;
  values: unknown;
}
export interface KbAuthorsTable {
  id: Generated<number>;
  name_key: string;
  version: Generated<number>;
  supersedes: number | null;
  name: string;
  handles: Generated<unknown>;
  first_seen: DateString | null;
  verified_sales_count: number | null;
  verified_sales_source: string | null;
  years_active: number | null;
  track_score: number | null;
  grade: Generated<'A' | 'B' | 'C' | 'D' | 'F'>;
  grade_reason: string | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbSourcesTable {
  id: Generated<number>;
  url: string;
  url_hash: string;
  version: Generated<number>;
  supersedes: number | null;
  publisher: string | null;
  author_id: number | null;
  title: string | null;
  published_at: Timestamp | null;
  retrieved_at: Timestamp;
  type: 'official_data' | 'paper' | 'dataset' | 'news' | 'practitioner_blog' | 'forum_post' | 'video' | 'comment' | 'vendor' | 'aggregator' | 'own_analysis';
  access_method: Generated<'rss' | 'api' | 'session_web' | 'manual'>;
  access_note: string | null;
  reliability: Generated<'A' | 'B' | 'C' | 'D' | 'F'>;
  reliability_reason: string | null;
  conflict_of_interest: Generated<'none' | 'sells_service' | 'sells_names' | 'marketplace' | 'unknown'>;
  excerpt: string | null;
  content_hash: string | null;
  minhash: string | null;
  topics: Generated<string[]>;
  status: Generated<'lead' | 'read' | 'graded' | 'rejected'>;
  rejected_reason: string | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbQuestionsTable {
  id: Generated<number>;
  slug: string;
  text: string;
  options: Generated<unknown>;
  population: string | null;
  decision_owner: string | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbClaimsTable {
  id: Generated<number>;
  claim_key: string;
  version: Generated<number>;
  supersedes: number | null;
  topic: string;
  question_ids: Generated<number[]>;
  option: string | null;
  statement: string;
  variable: string;
  direction: 'increases' | 'decreases' | 'no_effect' | 'value';
  effect_value: number | null;
  effect_unit: string | null;
  effect_low: number | null;
  effect_high: number | null;
  population: string;
  date_range_start: DateString | null;
  date_range_end: DateString | null;
  half_life_days: number | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbEvidenceTable {
  id: Generated<number>;
  source_id: number;
  claim_id: number;
  locator: Generated<string>;
  version: Generated<number>;
  supersedes: number | null;
  stance: 'supports' | 'contradicts' | 'qualifies';
  credibility: number;
  sample_size: number | null;
  evidence_kind: 'measured' | 'reported_sale' | 'experience' | 'opinion';
  population_match: Generated<'direct' | 'indirect'>;
  survivorship: Generated<boolean>;
  claim_grade: 'A' | 'B' | 'C' | 'D' | 'F' | null;
  effect_value: number | null;
  quote: string | null;
  extracted_by: string;
  extracted_at: Timestamp;
  extraction_check: Generated<'single' | 'double_agreed' | 'double_conflict'>;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbSourceLinksTable {
  id: Generated<number>;
  from_source_id: number;
  to_source_id: number;
  kind: 'echo_of' | 'cites' | 'same_author' | 'syndicated' | 'aggregator_of';
  version: Generated<number>;
  supersedes: number | null;
  retracted: Generated<boolean>;
  note: string | null;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface KbVerdictsTable {
  id: Generated<number>;
  question_id: number;
  computed_at: Timestamp;
  settings_version: number;
  result_hash: string;
  verdict: Json;
  certainty: 'high' | 'moderate' | 'low' | 'very_low';
  downgrades: Json;
  clusters_used: Json;
  weight_for: number;
  weight_against: number;
  inputs_snapshot: Json;
  by: string;
}
export interface KbLoadsTable {
  id: Generated<number>;
  file_name: string;
  sha256: string;
  loaded_at: TimestampDefault;
  ok: boolean;
  counts: Json;
  error: string | null;
}

/** v5.23.0 (CR-075): one row per name x venue x listing episode (only episodes that can be a positive or a matched negative).  */
export interface MarketNamesTable {
  episode_id: string;
  name: string;
  sld: string;
  tld: string;
  venue: string;
  listing_type: 'bin' | 'offer' | 'auction' | 'closeout';
  list_price_cents_first: number | null;
  list_price_cents_last: number | null;
  price_changes: number;
  first_seen: DateString;
  last_seen: DateString;
  days_listed: number;
  seen_days: number;
  sale_only: boolean;
  outcome: 'sold' | 'unsold' | 'unknown' | 'delisted';
  outcome_rule: string;
  sale_price_cents: number | null;
  sale_date: DateString | null;
  source: string;
  source_url: string | null;
  source_sha256: string | null;
  tier: 'A' | 'B' | 'C' | 'D';
  feat_asof: ColumnType<DateString | null, DateString | null | undefined, DateString | null>;
  dup_group: string | null;
  dup_sources: string[] | null;
  price_band: '500-999' | '1k-2.5k' | '2.5k-5k' | '5k-10k' | '10k+';
  sale_id: number | null;
  derived_at: TimestampDefault;
}

export interface MarketDqRunsTable {
  id: Generated<number>;
  checked_at: Timestamp;
  status: 'ok' | 'alert';
  results: ColumnType<unknown, string, string>;
}

/** v5.28.0 (CR-073): pick-proof. `day` is the pick day D; the pool is the closeouts of data date D-1. */
export interface PickproofDaysTable {
  day: DateString;
  data_date: DateString;
  pool_sha256: string;
  seed: number | string;
  k: number;
  pool_n: number;
  sources: ColumnType<unknown, string, string>;
  deadline: Timestamp;
  arms: ColumnType<unknown, string | null | undefined, string | null>;
  created_at: TimestampDefault;
  sealed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  /** v5.33.0 (CR-073a PP-V2): the recipe the day was frozen with. */
  recipe_version: ColumnType<string, string | undefined, string>;
}
export interface PickproofPoolTable {
  day: DateString;
  domain: string;
  source: string;
  price_cents: number;
  passes_k1: boolean;
  is_two_word: boolean;
}
export interface PickproofArmsTable {
  day: DateString;
  arm: 'A' | 'B1' | 'B2' | 'C1';
  domain: string;
  rank: number;
  price_cents: number;
}
export interface PickproofPicksHistoryTable {
  id: Generated<number>;
  day: DateString;
  names: ColumnType<unknown, string, string>;
  n: number;
  by: string;
  audit_id: string | null;
  created_at: TimestampDefault;
}
export interface PickproofLabelsTable {
  domain: string;
  day: DateString;
  label: 'taken' | 'not_taken' | 'unknown';
  checked_at: Timestamp;
  attempts: number;
  created_at_rdap: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  created_unknown: boolean;
  created_after_d: boolean | null;
  statuses: ColumnType<unknown, string | null | undefined, string | null>;
  reason: string | null;
}

export interface MarketMatchedSetsTable {
  asof: DateString;
  ratio: number;
  seed: number;
  sha256: string;
  payload: ColumnType<unknown, string, string>;
  created_at: TimestampDefault;
}

/** v5.39.0 (CR-077): one pre-bid safety answer (append-only). */
export interface PrebidChecksTable {
  id: Generated<number>;
  domain: string;
  venue: 'godaddy' | 'dynadot';
  verdict: 'pass' | 'flag' | 'fail';
  answer: Json;
  token_name: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

/** v5.39.0 (CR-077): a bid plan approved by Dvir. Mutable status; every change is a bid_plan_events row. */
export interface BidPlansTable {
  id: Generated<number>;
  domain: string;
  venue: 'godaddy' | 'dynadot';
  kind: 'auction' | 'fixed_price' | 'closeout';
  auction_end_at: Date | string | null;
  max_bid_cents: number;
  prebid_id: number;
  status: Generated<'open' | 'won' | 'lost' | 'withdrawn' | 'expired'>;
  manual: Json;
  reasons: Json;
  approval_text: string;
  approval_at: Date | string;
  created_by: string | null;
  audit_id: string | null;
  final_price_cents: number | null;
  ended_at: Date | string | null;
  created_at: TimestampDefault;
  updated_at: TimestampDefault;
}

export interface BidPlanEventsTable {
  id: Generated<number>;
  plan_id: number;
  event: 'created' | 'won' | 'lost' | 'withdrawn' | 'expired' | 'imported';
  from_status: string | null;
  to_status: string;
  final_price_cents: number | null;
  ended_at: Date | string | null;
  detail: Json | null;
  actor: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ForwardCostPlansTable {
  id: Generated<number>;
  domain_id: number;
  version: number;
  line_count: number;
  token_name: string | null;
  audit_id: string | null;
  created_at: TimestampDefault;
}

export interface ForwardCostLinesTable {
  id: Generated<number>;
  plan_id: number;
  line_no: number;
  month: string;
  item: string;
  planned_cents: number;
  basis: string;
  cost_type: string;
}

export interface Database {
  api_tokens: ApiTokensTable;
  settings: SettingsTable;
  snapshot_manifests: SnapshotManifestsTable;
  datasave_pool: DatasavePoolTable;
  dynadot_rows: DynadotRowsTable;
  godaddy_auctions: GodaddyAuctionsTable;
  godaddy_auctions_live: GodaddyAuctionsLiveTable;
  auction_shortlist: AuctionShortlistTable;
  market_sales: MarketSalesTable;
  kb_settings: KbSettingsTable;
  kb_authors: KbAuthorsTable;
  kb_sources: KbSourcesTable;
  kb_questions: KbQuestionsTable;
  kb_claims: KbClaimsTable;
  kb_evidence: KbEvidenceTable;
  kb_source_links: KbSourceLinksTable;
  kb_verdicts: KbVerdictsTable;
  kb_loads: KbLoadsTable;
  market_names: MarketNamesTable;
  market_dq_runs: MarketDqRunsTable;
  market_matched_sets: MarketMatchedSetsTable;
  pickproof_days: PickproofDaysTable;
  pickproof_pool: PickproofPoolTable;
  pickproof_arms: PickproofArmsTable;
  pickproof_picks_history: PickproofPicksHistoryTable;
  pickproof_labels: PickproofLabelsTable;
  rdap_cache: RdapCacheTable;
  lookup_usage: LookupUsageTable;
  disappearances: DisappearancesTable;
  closeout_expiries: CloseoutExpiriesTable;
  prebid_checks: PrebidChecksTable;
  bid_plans: BidPlansTable;
  bid_plan_events: BidPlanEventsTable;
  forward_cost_plans: ForwardCostPlansTable;
  forward_cost_lines: ForwardCostLinesTable;
  deals: DealsTable;
  domains: DomainsTable;
  ledger_entries: LedgerEntriesTable;
  listing_history: ListingHistoryTable;
  quotes: QuotesTable;
  purchases: PurchasesTable;
  receipts: ReceiptsTable;
  audit_log: AuditLogTable;
  idempotency_keys: IdempotencyKeysTable;
  export_runs: ExportRunsTable;
  export_uploads: ExportUploadsTable;
  pricing_settings: PricingSettingsTable;
  price_schedule: PriceScheduleTable;
  pricing_evidence: PricingEvidenceTable;
  offers: OffersTable;
  registrar_presence: RegistrarPresenceTable;
  sales: SalesTable;
  selection_settings: SelectionSettingsTable;
  selection_lists: SelectionListsTable;
  sibling_method_approvals: SiblingMethodApprovalsTable;
  domain_records: DomainRecordsTable;
  candidate_intake: CandidateIntakeTable;
  candidate_screenings: CandidateScreeningsTable;
  daily_candidate_lists: DailyCandidateListsTable;
  screening_evidence: ScreeningEvidenceTable;
  screening_runs: ScreeningRunsTable;
  tranches: TranchesTable;
  tranche_members: TrancheMembersTable;
  labelled_names: LabelledNamesTable;
  replay_runs: ReplayRunsTable;
  holdout_suites: HoldoutSuitesTable;
  test_sets: TestSetsTable;
  test_set_rows: TestSetRowsTable;
  screening_results: ScreeningResultsTable;
  screening_verdicts: ScreeningVerdictsTable;
  screening_packs: ScreeningPacksTable;
  manual_quotes: ManualQuotesTable;
  rdap_lookups: RdapLookupsTable;
  reference_files: ReferenceFilesTable;
  namebio_keyword_stats: NamebioKeywordStatsTable;
  namebio_calls: NamebioCallsTable;
  job_runs: JobRunsTable;
  job_queue_runs: JobQueueRunsTable;
  job_steps: JobStepsTable;
  api_usage: ApiUsageTable;
  portfolio_checks: PortfolioChecksTable;
  registrar_state_checks: RegistrarStateChecksTable;
  venue_listings: VenueListingsTable;
  portfolio_stats: PortfolioStatsTable;
  outreach_emails: OutreachEmailsTable;
  holdout: HoldoutTable;
  scout_lessons: ScoutLessonsTable;
  sales_pattern_uploads: SalesPatternUploadsTable;
  sales_pattern_rows: SalesPatternRowsTable;
  listing_sync_log: ListingSyncLogTable;
  sibling_scans: SiblingScansTable;
  keyword_demand_uploads: KeywordDemandUploadsTable;
  keyword_demand: KeywordDemandTable;
  engine_uploads: EngineUploadsTable;
  engine_sales: EngineSalesTable;
  engine_unsold: EngineUnsoldTable;
  domain_rdap: DomainRdapTable;
  live_checks: LiveChecksTable;
  tm_kills: TmKillsTable;
  bigco_names: BigcoNamesTable;
  sales_comps: SalesCompsTable;
  visit_forwards: VisitForwardsTable;
  visit_daily: VisitDailyTable;
  engine_endings: EngineEndingsTable;
  owned_ending_events: OwnedEndingEventsTable;
  engine_models: EngineModelsTable;
  drop_lists: DropListsTable;
  drop_list_rows: DropListRowsTable;
  drop_list_checks: DropListChecksTable;
  cohorts: CohortsTable;
  cohort_names: CohortNamesTable;
  cohort_decisions: CohortDecisionsTable;
  cohort_outcomes: CohortOutcomesTable;
  company_documents: CompanyDocumentsTable;
  forbidden_terms: ForbiddenTermsTable;
  forbidden_term_retirements: ForbiddenTermRetirementsTable;
  review_packets: ReviewPacketsTable;
  review_feedback: ReviewFeedbackTable;
  review_items: ReviewItemsTable;
  review_item_statuses: ReviewItemStatusesTable;
  review_settings_changes: ReviewSettingsChangesTable;
  review_retries: ReviewRetriesTable;
}

export type AuditRowInsert = Insertable<AuditLogTable>;
export type DomainRow = Selectable<DomainsTable>;
export type DomainInsert = Insertable<DomainsTable>;
export type DomainUpdate = Updateable<DomainsTable>;
