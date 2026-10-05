import type { ColumnType, Generated, Insertable, Selectable, Updateable } from 'kysely';

/** 'YYYY-MM-DD'. pg's date parser is overridden in client.ts so dates never become JS Date. */
export type DateString = string;
type Timestamp = ColumnType<Date, Date | string, Date | string>;
type TimestampDefault = ColumnType<Date, Date | string | undefined, Date | string>;
type Json = ColumnType<unknown, string, string>; // insert/update with JSON.stringify(...)

export type Scope = 'read' | 'write';
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
}

export interface SettingsTable {
  id: Generated<boolean>;
  poc_cap_cents: Generated<number>;
  max_domains: Generated<number>;
  approval_max_age_hours: Generated<number>;
  lander_target: Generated<'afternic' | 'sedo' | 'custom'>;
  allowed_registrars: Generated<string[]>;
  geo_bin_min_cents: Generated<number>;
  geo_bin_max_cents: Generated<number>;
  high_value_categories: Generated<Category[]>;
  high_value_min_bin_cents: Generated<number>;
  high_value_guard_modes: Generated<ListingMode[]>;
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
  scope: Scope | 'admin' | null;
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
  final_push_mode: 'bin_to_floor_ceil95';
  delist_days_before_drop: number;
  headsup_days_before: number;
  comps_min: number;
  comps_max: number;
  public_lto: boolean;
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
  pricing_settings: PricingSettingsTable;
  price_schedule: PriceScheduleTable;
  pricing_evidence: PricingEvidenceTable;
}

export type AuditRowInsert = Insertable<AuditLogTable>;
export type DomainRow = Selectable<DomainsTable>;
export type DomainInsert = Insertable<DomainsTable>;
export type DomainUpdate = Updateable<DomainsTable>;
