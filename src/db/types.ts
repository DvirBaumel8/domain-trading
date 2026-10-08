import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** 'YYYY-MM-DD'. pg's date parser is overridden in client.ts so dates never become JS Date. */
export type DateString = string;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>; // insert/update with JSON.stringify(...)

export type Scope = 'read' | 'write' | 'intake';
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
  poc_cap_cents: Generated<number>;
  max_domains: Generated<number>;
  approval_max_age_hours: Generated<number>;
  lander_target: Generated<'afternic' | 'sedo' | 'custom'>;
  allowed_registrars: Generated<string[]>;
  high_value_min_bin_cents: Generated<number>;
  sedo_hybrid_as: Generated<'buy_now' | 'make_offer'>;
  updated_at: TimestampDefault;
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
  renewals_used: Generated<number>;
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
  job: 'tick' | 'daily';
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
  job: 'tick' | 'daily';
  trigger: 'scheduled' | 'manual' | 'cli';
  scheduled_for: ColumnType<Date | null, Date | string | null | undefined, never>;
  triggered_by: ColumnType<string | null, string | null | undefined, never>;
  created_at: TimestampDefault;
}

export type JobStepStatus = 'queued' | 'running' | 'done' | 'failed' | 'skipped';

/** One step of a queued run (v3.0.0); status only moves forward (trigger job_steps_guard). */
export interface JobStepsTable {
  id: Generated<number>;
  run_id: string;
  job: 'tick' | 'daily';
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

export interface PortfolioChecksTable {
  id: Generated<number>;
  domain_id: number;
  at: TimestampDefault;
  kind: 'registry' | 'web' | 'blocklist';
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
}
export interface CandidateScreeningsTable {
  id: Generated<string>;
  intake_id: string | null;
  domain: string;
  origin: 'intake' | 'drop_list';
  run_id: string;
  day: DateString;
  at: TimestampDefault;
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
  kind: 'tm_us' | 'history';
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
  spend_cap_cents: number | null;
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
  est_cost_cents: number | null;
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

export interface PostsTable {
  id: string;
  created_at: TimestampDefault;
  created_by: string;
  audit_id: string | null;
  idempotency_key: string | null;
  text: string;
  thread: Json;
  status: ColumnType<'pending' | 'posted' | 'failed' | 'removed' | 'unknown', 'pending' | 'posted' | 'failed' | 'removed' | 'unknown', 'posted' | 'failed' | 'removed' | 'unknown'>;
  buffer_post_id: string | null;
  external_link: ColumnType<string | null, string | null | undefined, string | null>;
  sent_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  error: ColumnType<string | null, string | null | undefined, string | null>;
  removed_at: ColumnType<Date | null, Date | string | null | undefined, Date | string | null>;
  removed_reason: ColumnType<string | null, string | null | undefined, string | null>;
  idt_day: string;
}

export interface PostImagesTable {
  id: Generated<number>;
  post_id: string;
  part: number;
  position: number;
  mime: 'image/png' | 'image/jpeg';
  bytes: number;
  width: number;
  height: number;
  sha256: string;
  alt: string;
  data: Buffer | null;
  media_token: string;
  media_expires_at: Timestamp;
  created_at: TimestampDefault;
}

export interface PostingSwitchesTable {
  id: Generated<number>;
  at: TimestampDefault;
  by: string;
  audit_id: string | null;
  paused: boolean;
  reason: string | null;
}

export interface PostingBurstsTable {
  id: Generated<number>;
  day: string;
  cap: number;
  at: TimestampDefault;
  by: string;
  audit_id: string | null;
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

export interface Database {
  api_tokens: ApiTokensTable;
  settings: SettingsTable;
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
  job_runs: JobRunsTable;
  job_queue_runs: JobQueueRunsTable;
  job_steps: JobStepsTable;
  api_usage: ApiUsageTable;
  portfolio_checks: PortfolioChecksTable;
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
  posts: PostsTable;
  post_images: PostImagesTable;
  posting_switches: PostingSwitchesTable;
  posting_bursts: PostingBurstsTable;
}

export type AuditRowInsert = Insertable<AuditLogTable>;
export type DomainRow = Selectable<DomainsTable>;
export type DomainInsert = Insertable<DomainsTable>;
export type DomainUpdate = Updateable<DomainsTable>;
