-- Up Migration
--
-- Baseline: replaces the 22 migrations below (squashed 2026-10-06, before any deployment).
-- Contents: the full final schema (tables, columns, constraints, indexes, identity sequences, functions,
-- append-only / immutability / read-only triggers) as produced by pg_dump --schema-only, followed by the seed data.
-- Seed functions seed_pricing_settings_v2(), seed_selection_v1() and seed_signature_lists_v2() are kept
-- (tests/helpers/db.ts resetDb calls them); the seed rows are created by calling them, in the original order.
-- Squashed migrations:
--   1759600000000_initial-schema
--   1759700000000_buy
--   1759800000000_listing
--   1759900000000_pricing
--   1760000000000_drop-v1-listing-settings
--   1760100000000_exports-v2
--   1760200000000_export-run-detail
--   1760300000000_offers
--   1760400000000_lifecycle
--   1760500000000_payouts
--   1760600000000_bot-autonomy
--   1760700000000_registrar-presence
--   1760800000000_drop-payouts-offer-imports
--   1760900000000_full-file-exports
--   1761000000000_pricing-v3
--   1761100000000_selection
--   1761200000000_screening
--   1761300000000_reference-caches
--   1761400000000_signature-lists-v2
--   1761500000000_tranches
--   1761600000000_tranches-readonly
--   1761700000000_replay

-- Function bodies may reference tables created further down.
SET LOCAL check_function_bodies = false;

--
-- Name: offers_facts_immutable(); Type: FUNCTION
--

CREATE FUNCTION public.offers_facts_immutable() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'offers: DELETE is not allowed'; END IF;
  IF (NEW.domain_id, NEW.amount_cents, NEW.source, NEW.received_at, NEW.buyer_type, NEW.buyer_ref, NEW.external_ref,
      NEW.bin_cents_at, NEW.floor_cents_at, NEW.walkaway_cents_at, NEW.min_offer_cents_at, NEW.listing_history_id,
      NEW.band, NEW.routing, NEW.note, NEW.recorded_by, NEW.audit_id, NEW.created_at)
     IS DISTINCT FROM
     (OLD.domain_id, OLD.amount_cents, OLD.source, OLD.received_at, OLD.buyer_type, OLD.buyer_ref, OLD.external_ref,
      OLD.bin_cents_at, OLD.floor_cents_at, OLD.walkaway_cents_at, OLD.min_offer_cents_at, OLD.listing_history_id,
      OLD.band, OLD.routing, OLD.note, OLD.recorded_by, OLD.audit_id, OLD.created_at) THEN
    RAISE EXCEPTION 'offers: facts are immutable; only outcome fields may change';
  END IF;
  RETURN NEW;
END $$;

--
-- Name: reject_mutation(); Type: FUNCTION
--

CREATE FUNCTION public.reject_mutation() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

--
-- Name: seed_pricing_settings_v2(); Type: FUNCTION
--

CREATE FUNCTION public.seed_pricing_settings_v2() RETURNS void
    LANGUAGE sql
    AS $_$
  INSERT INTO pricing_settings (
    version, effective_at, approval_text, approval_at, note,
    geo_bin_strong_cents, geo_bin_weaker_cents, geo_bin_min_cents, geo_bin_max_cents,
    geo_drops_enabled, geo_drops, floor_bps, floor_min_cents, walkaway_bps, walkaway_min_cents,
    hybrid_min_offer_cents, drops, final_push_days_before_drop, final_push_mode,
    delist_days_before_drop, headsup_days_before, comps_min, comps_max, public_lto
  ) VALUES (
    2, '2026-10-05T09:17:00+03:00',
    'v2: $500 walk-away floor, one geo drop, Sedo make-offer, final push to floor', '2026-10-05T09:17:00+03:00',
    'pricing rules v2 (Gavriel spec commit 3488942, approved by Dvir)',
    49900, 39900, 29900, 49900,
    true, '[{"after_months":12,"from_cents":49900,"to_cents":39900}]'::jsonb,
    6500, 75000, 4800, 50000,
    10000, '[{"after_months":6,"pct_bps":2000},{"after_months":18,"pct_bps":2000}]'::jsonb, 90, 'bin_to_floor_ceil95',
    7, 7, 2, 3, false
  );
$_$;

--
-- Name: seed_selection_v1(); Type: FUNCTION
--

CREATE FUNCTION public.seed_selection_v1() RETURNS void
    LANGUAGE plpgsql
    AS $_$
BEGIN
  INSERT INTO selection_settings
    (label, values, note, created_by, activation_seq, activated_at, activation_approval_text, activation_approval_at, activated_by)
  VALUES (
    'v1',
    $sel${"thresholds":{"registered_share_min":0.5,"registered_share_min_B":0.6,"form_B_max_words":2,"alt_tld_before_min":1},"form":{"geo_bands":[{"max_chars":12,"raw":10},{"max_chars":16,"raw":7},{"max_chars":20,"raw":4},{"max_chars":null,"raw":1}],"unknown_token_fails":true,"ambiguity_margin":2,"token_costs":{"typed":1,"dict3":2,"dict2":3},"short_max_words":2,"short_max_chars":12,"geo_max_words":2,"geo_max_chars":16,"geo_city_one_token":true,"formB_max_words":2,"legal_terms_list":"legal","short_token_flag_min":2,"city_word_allowlist":["akron","albany","albuquerque","amarillo","anaheim","anchorage","arlington","asheville","atlanta","austin","bakersfield","baltimore","berlin","billings","birmingham","boise","boston","brisbane","brooklyn","burbank","charleston","charlotte","chattanooga","chesapeake","cheyenne","chicago","cincinnati","cleveland","columbia","columbus","dallas","dayton","denver","detroit","dublin","durham","edmonton","eugene","evansville","fargo","fayetteville","fremont","fresno","gilbert","glendale","greensboro","hartford","henderson","hollywood","houston","huntsville","indianapolis","irvine","irving","jackson","jacksonville","knoxville","lansing","laredo","lexington","lincoln","london","louisville","lubbock","madison","malibu","manchester","manhattan","melbourne","memphis","miami","milwaukee","minneapolis","modesto","montgomery","montreal","napa","naples","nashville","newark","norfolk","oakland","olympia","omaha","ontario","orlando","ottawa","oxnard","paris","pasadena","peoria","perth","philadelphia","phoenix","pittsburgh","plano","portland","raleigh","richmond","riverside","rochester","rockford","sacramento","salem","sarasota","savannah","scottsdale","seattle","shreveport","spokane","springfield","stockton","syracuse","tacoma","tallahassee","tampa","toledo","topeka","toronto","tucson","tulsa","vancouver","washington","wichita","worcester","yonkers"]},"typo":{"max_edit_distance":1,"top_n":10000,"max_list_age_days":7},"concentration":{"max_per_attr":2,"max_lane_share":0.4,"lane_share_enforced":false},"tranche":{"size":15,"min_main_lane":10,"geo_max":1,"required_for_buy":true},"surbl":{"zone":"multi.surbl.org","control_name":"test.surbl.org","blocked_answers":["127.0.0.1"],"list_bits":{"4":"DM","8":"PH","16":"MW","32":"CT","64":"ABUSE","128":"CR"},"ns_override":[],"timeout_ms":3000},"history":{"max_fetch_per_name":6,"min_ms_between_calls":1000,"timeout_ms":20000,"retries":2,"min_content_chars":200,"parked_max_text_chars":1500,"url_terms":["viagra","cialis","xanax","casino","poker","porn","xxx","escort","payday loan","replica watches","buy backlinks"],"strong_action":"FAIL","weak_action":"FLAG","redirect_action":"FLAG","forsale_action":"PASS","parked_action":"PASS"},"census":{"sibling_count":20,"max_unknown_share":0.25,"as_of_exact_max_days":365},"ext":{"list":["net","org","co","io","ai","info","us"]},"tier":{"order":["A","I","B","G"],"clauses":{"A":{"all":[{"f":"registered_share","op":">=","v":"$registered_share_min"},{"f":"prior_history","op":"==","v":1}]},"I":{"any":[{"tier":"A"},{"f":"alt_tld_before_n","op":">=","v":"$alt_tld_before_min"}]},"B":{"all":[{"f":"registered_share","op":">=","v":"$registered_share_min_B"},{"f":"n_words","op":"<=","v":"$form_B_max_words"}]},"G":{"all":[{"f":"is_geo","op":"==","v":1},{"f":"gform1_pass","op":"==","v":1}]}},"demand2_pass_tiers":["I","B","G"],"p_passive":{"A":0.02,"I":0.02,"B":0.01,"G":0.01}},"lead":{"gate_enabled":false,"ab_min":{"S2":8,"S3":5,"S4":5,"S6":5,"S7":5},"p_lead":{"S2":0.005,"S3":0.002,"S4":0.002,"S6":0.003,"S7":0.002}},"priors_v91":{"p_passive":{"S2":0.005,"S3":0.004,"S4":0.004,"S6":0.005,"S7":0.004}},"money":{"net_factor_afternic":0.85,"net_factor_other":0.75,"hold_years":2},"lander":{"exception_ab_min":30,"exception_retail_end_min":20},"price":{"forbidden_bands_cents":[[80000,99900],[195000,199900]],"geo_default_grade":"strong"},"score":{"weights":{"S2":{"A":15,"B":30,"C":5,"D":10,"E":10,"F":5,"G":25},"S3":{"A":15,"B":20,"C":15,"D":10,"E":25,"F":10,"G":5},"S4":{"A":15,"B":20,"C":15,"D":10,"E":25,"F":10,"G":5},"S6":{"A":15,"B":25,"C":10,"D":10,"E":20,"F":5,"G":15},"S7":{"A":10,"B":20,"C":5,"D":15,"E":10,"F":5,"G":35}},"coverage_min":0.7,"coverage_gate":false,"parked_penalty":0,"nongeo_len_bands":[{"max":8,"raw":10},{"max":12,"raw":7},{"max":16,"raw":4},{"max":null,"raw":1}],"words_bands":[{"max":1,"raw":10},{"max":2,"raw":8},{"max":3,"raw":5},{"max":null,"raw":2}],"syllable_bands":[{"max":3,"raw":10},{"max":5,"raw":7},{"max":7,"raw":4},{"max":null,"raw":1}],"d_bands":[{"min":30,"raw":9},{"min":10,"raw":6},{"min":0,"raw":2}],"retail_only_max_points":10,"risk_raw":{"clean":10,"flag":5},"forbidden_feature_keys":["govalue_usd","estibot_value","humbleworth_usd","alexa_rank","appraisal_usd"]},"namebio":{"max_cache_age_hours":48,"spot_max_per_min":4,"attribution":"Data from NameBio"},"quote":{"max_age_hours":24,"manual_max_age_days":30},"web_risk":{"safe_statuses":[1,6],"unsafe_statuses":[2,3],"requires_clean_history":true},"freshness_hours":{"availability":1,"surbl":24,"typo":24,"history":168,"census":720,"ext_dates":168,"namebio":24,"quote":24,"web_risk":168,"tm_us":168},"evidence":{"max_text_bytes":32768},"run":{"time_budget_minutes":30,"rdap_concurrency":1,"rdap_min_ms_between":1000,"feature_checks":["census","ext_dates","namebio"],"gates":{"default":["form","brand_lists","typo","availability","concentration","surbl","web_risk","history","tm_us","census","ext_dates","tier","namebio","quote","price"],"S2":["form","brand_lists","typo","availability","concentration","surbl","web_risk","history","tm_us","tier","namebio","quote","price"]}},"profit":{"bin_price_cents":148800,"cost_per_name_year_cents":1108},"buy_hold":true,"holdout":{"sold_accept_min":0.7,"drop_reject_min":0.75,"min_n":50,"required_suites":["BT10-1","BT10-9","BT10-11"],"report_bands":[1000,2500],"lane_report":true,"base_rates":[0.01,0.02]},"sources":{"surbl":true,"popularity":true,"namebio":false,"wayback":false,"rdap_com":true,"rdap_other":true,"iana_bootstrap":true}}$sel$::jsonb,
    'CR-001 + CR-002 v10.1 defaults',
    'migration', 1, now(),
    'CR-001 approved by Dvir 2026-10-06 02:05 IDT; CR-002 v10.1 defaults approved by Dvir 2026-10-06 03:24 IDT',
    '2026-10-06T03:24:00+03:00', 'migration');
  INSERT INTO selection_lists (name, version, terms, created_by, note) VALUES
    ('trade', 1, ARRAY['accident', 'accounting', 'appliance', 'auto', 'autobody', 'bakery', 'barber', 'bath', 'bathroom', 'bookkeeping', 'brewery', 'builder', 'builders', 'cabinet', 'cabinets', 'carpet', 'catering', 'chiro', 'chiropractor', 'cleaners', 'cleaning', 'clinic', 'clinics', 'coffee', 'concrete', 'construction', 'contractor', 'contractors', 'cooling', 'countertops', 'cpa', 'dental', 'dentist', 'dentists', 'door', 'doors', 'drywall', 'electric', 'electrical', 'electrician', 'electricians', 'epoxy', 'fence', 'fencing', 'floor', 'flooring', 'floors', 'foundation', 'garage', 'granite', 'gutter', 'gutters', 'handyman', 'hauling', 'heating', 'home', 'homes', 'hotel', 'house', 'houses', 'hvac', 'injury', 'insurance', 'junk', 'kitchen', 'landscape', 'landscaping', 'lawn', 'limo', 'locksmith', 'maid', 'masonry', 'massage', 'medspa', 'mold', 'mortgage', 'motel', 'movers', 'moving', 'ortho', 'orthodontist', 'painter', 'painters', 'painting', 'paving', 'pest', 'pestcontrol', 'physio', 'pizza', 'plumber', 'plumbers', 'plumbing', 'pool', 'pools', 'realtor', 'realty', 'rehab', 'remodel', 'remodeling', 'rental', 'rentals', 'repair', 'restaurant', 'restoration', 'roof', 'roofer', 'roofers', 'roofing', 'salon', 'septic', 'siding', 'solar', 'spa', 'stone', 'storage', 'tattoo', 'tax', 'taxi', 'therapist', 'therapy', 'tours', 'towing', 'travel', 'tree', 'trees', 'urgentcare', 'vet', 'veterinary', 'water', 'waterdamage', 'wedding', 'weddings', 'window', 'windows', 'winery']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('regime', 1, ARRAY['aml', 'ccpa', 'csrd', 'dora', 'esg', 'fedramp', 'gdpr', 'hipaa', 'iso', 'kyc', 'nis', 'nist', 'pci', 'soc', 'sox']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('tech', 1, ARRAY['ads', 'agent', 'agents', 'ai', 'analytics', 'api', 'app', 'apps', 'ar', 'audit', 'audits', 'automation', 'batteries', 'battery', 'billing', 'bitcoin', 'blockchain', 'bot', 'bots', 'carbon', 'chatbot', 'climate', 'cloud', 'code', 'coding', 'compliance', 'crm', 'crypto', 'cyber', 'data', 'defi', 'dev', 'devops', 'digital', 'drone', 'drones', 'email', 'energy', 'erp', 'ev', 'fintech', 'fraud', 'genai', 'governance', 'gpt', 'grid', 'hosting', 'hydrogen', 'identity', 'invoice', 'invoicing', 'iot', 'lab', 'labs', 'lead', 'leads', 'llm', 'marketing', 'media', 'metaverse', 'ml', 'nft', 'online', 'payment', 'payments', 'payroll', 'platform', 'privacy', 'prompt', 'quantum', 'risk', 'robot', 'robotics', 'saas', 'secure', 'security', 'seo', 'sms', 'software', 'tech', 'token', 'verification', 'verify', 'vision', 'voice', 'vpn', 'vr', 'web']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('generic_head', 1, ARRAY['center', 'centre', 'club', 'co', 'company', 'depot', 'direct', 'expert', 'experts', 'express', 'group', 'guys', 'hq', 'hub', 'inc', 'labs', 'market', 'mart', 'nation', 'network', 'now', 'online', 'partners', 'pro', 'pros', 'service', 'services', 'shop', 'solutions', 'source', 'store', 'supplies', 'supply', 'systems', 'team', 'tech', 'today', 'usa', 'works', 'world']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('state', 1, ARRAY['alabama', 'alaska', 'arizona', 'arkansas', 'cali', 'california', 'colorado', 'connecticut', 'delaware', 'florida', 'georgia', 'hawaii', 'idaho', 'illinois', 'indiana', 'iowa', 'jersey', 'kansas', 'kentucky', 'la', 'louisiana', 'maine', 'maryland', 'massachusetts', 'michigan', 'minnesota', 'mississippi', 'missouri', 'montana', 'nebraska', 'nevada', 'newhampshire', 'newjersey', 'newmexico', 'newyork', 'norcal', 'northcarolina', 'northdakota', 'nyc', 'ohio', 'oklahoma', 'oregon', 'pennsylvania', 'rhodeisland', 'sf', 'socal', 'southcarolina', 'southdakota', 'tennessee', 'texas', 'utah', 'vermont', 'virginia', 'westvirginia', 'wisconsin', 'wyoming']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('legal', 1, ARRAY['attorney', 'attorneys', 'law', 'lawfirm', 'lawyer', 'lawyers', 'legal']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('sig_harmful_strong', 1, ARRAY['adult:free sex', 'adult:porn', 'adult:xxx', 'gambling:online casino', 'gambling:online poker', 'hacked_spam:cheap jerseys', 'hacked_spam:cheap replica', 'malware:download now to remove virus', 'malware:your computer is infected', 'pharma:buy xanax', 'pharma:cialis', 'pharma:viagra', 'phishing:confirm your password', 'phishing:verify your account', 'scam:double your bitcoin', 'scam:you have won']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('sig_harmful_weak', 1, ARRAY['adult:dating', 'adult:escort', 'gambling:betting', 'gambling:casino', 'pharma:pharmacy', 'scam:get rich']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('sig_parked', 1, ARRAY['parked:coming soon', 'parked:domain parking', 'parked:future home of', 'parked:not yet connected', 'parked:parked free', 'parked:this domain is parked', 'parked:under construction']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)'),
    ('sig_forsale', 1, ARRAY['forsale:buy this domain', 'forsale:domain may be for sale', 'forsale:inquire about this domain', 'forsale:make an offer on this domain', 'forsale:this domain is for sale']::text[], 'migration', 'v1 starter list (DOM-curated from CR-001 reference lex.py / DOM starter set)');
END
$_$;

--
-- Name: seed_signature_lists_v2(); Type: FUNCTION
--

CREATE FUNCTION public.seed_signature_lists_v2() RETURNS void
    LANGUAGE plpgsql
    AS $$
DECLARE
  r record;
  cur text[];
  nxt integer;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('sig_harmful_strong', ARRAY['pbn:buy backlinks', 'pbn:paid guest posts', 'pbn:private blog network', 'trademark:counterfeit handbags', 'trademark:fake rolex', 'trademark:replica watches']::text[]),
    ('sig_harmful_weak', ARRAY['pbn:guest post', 'pbn:sponsored post', 'pbn:write for us', 'trademark:knockoff', 'trademark:replica']::text[]),
    ('sig_parked', ARRAY['parked:above.com', 'parked:alldomains.com', 'parked:bodis.com', 'parked:default web site page', 'parked:parkingcrew.net', 'parked:sedoparking.com']::text[]),
    ('sig_forsale', ARRAY['forsale:afternic.com', 'forsale:atom.com', 'forsale:brandbucket.com', 'forsale:buydomains.com', 'forsale:dan.com', 'forsale:hugedomains.com', 'forsale:sedo.com', 'forsale:squadhelp.com', 'forsale:this domain name is for sale', 'forsale:undeveloped.com']::text[])
  ) AS v(name, extra) LOOP
    SELECT terms, version INTO cur, nxt FROM selection_lists WHERE name = r.name ORDER BY version DESC LIMIT 1;
    INSERT INTO selection_lists (name, version, terms, created_by, note)
    VALUES (r.name, COALESCE(nxt, 0) + 1,
      ARRAY(SELECT DISTINCT t FROM unnest(COALESCE(cur, ARRAY[]::text[]) || r.extra) AS t ORDER BY t),
      'migration', 'v2 starter additions (DOM): pbn and trademark classes; parking and for-sale marketplace hosts for redirect targets');
  END LOOP;
END
$$;

--
-- Name: selection_settings_guard(); Type: FUNCTION
--

CREATE FUNCTION public.selection_settings_guard() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF TG_OP = 'UPDATE'
     AND OLD.activation_seq IS NULL AND NEW.activation_seq IS NOT NULL
     AND (NEW.id, NEW.label, NEW.values, NEW.based_on_id, NEW.note, NEW.created_at, NEW.created_by, NEW.audit_id)
         IS NOT DISTINCT FROM (OLD.id, OLD.label, OLD.values, OLD.based_on_id, OLD.note, OLD.created_at, OLD.created_by, OLD.audit_id) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP;
END
$$;

--
-- Name: tranche_members_guard_update(); Type: FUNCTION
--

CREATE FUNCTION public.tranche_members_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF (SELECT status FROM tranches WHERE id = OLD.tranche_id) = 'closed' THEN
    RAISE EXCEPTION 'tranche % is closed and read-only', OLD.tranche_id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  -- On an open tranche a member can only be removed (removed_at / removed_by set once, from NULL); nothing else changes.
  IF OLD.removed_at IS NOT NULL
     OR (to_jsonb(NEW) - 'removed_at' - 'removed_by') IS DISTINCT FROM (to_jsonb(OLD) - 'removed_at' - 'removed_by') THEN
    RAISE EXCEPTION 'tranche member % can only be removed, once', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

--
-- Name: tranches_guard_update(); Type: FUNCTION
--

CREATE FUNCTION public.tranches_guard_update() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  IF OLD.status = 'closed' THEN
    RAISE EXCEPTION 'tranche % is closed and read-only', OLD.id USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;

--
-- Name: api_tokens; Type: TABLE
--

CREATE TABLE public.api_tokens (
    id bigint NOT NULL,
    name text NOT NULL,
    scope text NOT NULL,
    token_sha256 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    revoked_at timestamp with time zone,
    last_used_at timestamp with time zone,
    CONSTRAINT api_tokens_name_check CHECK (((length(name) >= 1) AND (length(name) <= 100))),
    CONSTRAINT api_tokens_scope_check CHECK ((scope = ANY (ARRAY['read'::text, 'write'::text]))),
    CONSTRAINT api_tokens_token_sha256_check CHECK ((token_sha256 ~ '^[0-9a-f]{64}$'::text))
);

--
-- Name: api_tokens_id_seq; Type: SEQUENCE
--

ALTER TABLE public.api_tokens ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.api_tokens_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: audit_log; Type: TABLE
--

CREATE TABLE public.audit_log (
    id text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    token_id bigint,
    scope text,
    method text NOT NULL,
    path text NOT NULL,
    idempotency_key text,
    approval_text text,
    approval_at timestamp with time zone,
    request jsonb,
    status_code integer NOT NULL,
    result_summary text,
    client_ip text,
    CONSTRAINT audit_log_id_check CHECK ((id ~ '^aud_[0-9a-f]{32}$'::text)),
    CONSTRAINT audit_log_scope_check CHECK ((scope = ANY (ARRAY['read'::text, 'write'::text, 'admin'::text, 'job'::text])))
);

--
-- Name: deals; Type: TABLE
--

CREATE TABLE public.deals (
    id text NOT NULL,
    domain text,
    strategy text,
    status_note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT deals_domain_check CHECK ((domain = lower(domain))),
    CONSTRAINT deals_id_check CHECK ((id ~ '^D-[0-9]{3,}$'::text))
);

--
-- Name: domains; Type: TABLE
--

CREATE TABLE public.domains (
    id bigint NOT NULL,
    domain text NOT NULL,
    deal_id text,
    registrar text,
    status text NOT NULL,
    buy_date date,
    cost_cents integer,
    expiry_date date,
    renewal_price_cents integer,
    renewals_used smallint DEFAULT 0 NOT NULL,
    drop_date date,
    category text,
    listing_mode text,
    bin_cents integer,
    floor_cents integer,
    min_offer_cents integer,
    lto_max_months smallint,
    display_name text,
    lander text,
    lander_ns text[],
    lander_set_at timestamp with time zone,
    ns_verified_at timestamp with time zone,
    registrar_api text,
    sold_at timestamp with time zone,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    delisted_at timestamp with time zone,
    walkaway_cents integer,
    price_grade text,
    pricing_source text,
    pricing_settings_version integer,
    first_listed_at timestamp with time zone,
    pricing_hold boolean DEFAULT false NOT NULL,
    pricing_hold_reason text,
    plan_id text,
    plan_audit_id text,
    export_pending_since timestamp with time zone,
    listing_changed_at timestamp with time zone,
    CONSTRAINT domains_bin_cents_check CHECK ((bin_cents > 0)),
    CONSTRAINT domains_category_check CHECK ((category = ANY (ARRAY['geo'::text, 'trend'::text, 'b2b'::text, 'collision'::text, 'regulation'::text, 'buzzword'::text, 'other'::text]))),
    CONSTRAINT domains_category_once_owned CHECK (((status = 'pending_purchase'::text) OR (category IS NOT NULL))),
    CONSTRAINT domains_cost_cents_check CHECK ((cost_cents >= 0)),
    CONSTRAINT domains_deal_id_check CHECK ((deal_id ~ '^D-[0-9]{3,}$'::text)),
    CONSTRAINT domains_domain_check CHECK (((domain = lower(domain)) AND ((length(domain) >= 4) AND (length(domain) <= 253)))),
    CONSTRAINT domains_drop_date_rule CHECK (((renewals_used = 1) OR (drop_date IS NULL) OR (drop_date = ((expiry_date + '1 year'::interval))::date) OR (drop_date = expiry_date))),
    CONSTRAINT domains_floor_cents_check CHECK ((floor_cents > 0)),
    CONSTRAINT domains_listing_mode_check CHECK ((listing_mode = ANY (ARRAY['bin'::text, 'offer'::text, 'hybrid'::text]))),
    CONSTRAINT domains_lto_max_months_check CHECK (((lto_max_months >= 2) AND (lto_max_months <= 60))),
    CONSTRAINT domains_min_offer_cents_check CHECK ((min_offer_cents >= 2000)),
    CONSTRAINT domains_owned_fields CHECK (((status = 'pending_purchase'::text) OR ((registrar IS NOT NULL) AND (registrar_api IS NOT NULL) AND (buy_date IS NOT NULL) AND (cost_cents IS NOT NULL) AND (expiry_date IS NOT NULL) AND (drop_date IS NOT NULL)))),
    CONSTRAINT domains_price_grade_check CHECK ((price_grade = ANY (ARRAY['strong'::text, 'weaker'::text]))),
    CONSTRAINT domains_price_order CHECK ((((floor_cents IS NULL) OR (bin_cents IS NULL) OR (floor_cents <= bin_cents)) AND ((walkaway_cents IS NULL) OR ((floor_cents IS NOT NULL) AND (walkaway_cents <= floor_cents))))),
    CONSTRAINT domains_pricing_source_check CHECK ((pricing_source = ANY (ARRAY['formula'::text, 'approved_exception'::text]))),
    CONSTRAINT domains_registrar_api_check CHECK ((registrar_api = ANY (ARRAY['full'::text, 'manage'::text, 'none'::text]))),
    CONSTRAINT domains_registrar_check CHECK ((lower(registrar) <> 'cloudflare'::text)),
    CONSTRAINT domains_renewal_price_cents_check CHECK ((renewal_price_cents >= 0)),
    CONSTRAINT domains_renewals_used_check CHECK (((renewals_used >= 0) AND (renewals_used <= 1))),
    CONSTRAINT domains_status_check CHECK ((status = ANY (ARRAY['pending_purchase'::text, 'owned'::text, 'listed'::text, 'delisted'::text, 'sold'::text, 'dropped'::text]))),
    CONSTRAINT domains_walkaway_cents_check CHECK ((walkaway_cents > 0))
);

--
-- Name: domains_id_seq; Type: SEQUENCE
--

ALTER TABLE public.domains ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.domains_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: export_runs; Type: TABLE
--

CREATE TABLE public.export_runs (
    id bigint NOT NULL,
    marketplace text NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    domains text[] DEFAULT '{}'::text[] NOT NULL,
    export_id text NOT NULL,
    CONSTRAINT export_runs_marketplace_check CHECK ((marketplace = ANY (ARRAY['afternic'::text, 'sedo'::text])))
);

--
-- Name: export_runs_id_seq; Type: SEQUENCE
--

ALTER TABLE public.export_runs ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.export_runs_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: export_uploads; Type: TABLE
--

CREATE TABLE public.export_uploads (
    id bigint NOT NULL,
    venue text NOT NULL,
    export_id text NOT NULL,
    domains text[] NOT NULL,
    uploaded_at timestamp with time zone NOT NULL,
    approval_text text,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    note text,
    CONSTRAINT export_uploads_approval_text_check CHECK (((approval_text IS NULL) OR (length(TRIM(BOTH FROM approval_text)) > 0))),
    CONSTRAINT export_uploads_note_check CHECK (((note IS NULL) OR (POSITION(('@'::text) IN (note)) = 0))),
    CONSTRAINT export_uploads_venue_check CHECK ((venue = ANY (ARRAY['afternic'::text, 'sedo'::text])))
);

--
-- Name: export_uploads_id_seq; Type: SEQUENCE
--

ALTER TABLE public.export_uploads ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.export_uploads_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: holdout_suites; Type: TABLE
--

CREATE TABLE public.holdout_suites (
    id integer NOT NULL,
    suite text NOT NULL,
    version integer NOT NULL,
    slices text[],
    sources text[],
    member_hash text NOT NULL,
    member_count integer NOT NULL,
    cell text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    approval_text text NOT NULL,
    approval_at timestamp with time zone NOT NULL,
    audit_id text,
    CONSTRAINT holdout_suites_cell_check CHECK ((cell ~ '^(pooled|lane:(expired|fresh|aged|geo))$'::text)),
    CONSTRAINT holdout_suites_check CHECK (((slices IS NOT NULL) OR (sources IS NOT NULL))),
    CONSTRAINT holdout_suites_member_count_check CHECK ((member_count > 0)),
    CONSTRAINT holdout_suites_member_hash_check CHECK ((member_hash ~ '^[0-9a-f]{64}$'::text)),
    CONSTRAINT holdout_suites_suite_check CHECK ((suite ~ '^[A-Za-z0-9._-]{1,40}$'::text)),
    CONSTRAINT holdout_suites_version_check CHECK ((version >= 1))
);

--
-- Name: holdout_suites_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.holdout_suites_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: holdout_suites_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.holdout_suites_id_seq OWNED BY public.holdout_suites.id;

--
-- Name: idempotency_keys; Type: TABLE
--

CREATE TABLE public.idempotency_keys (
    key text NOT NULL,
    request_hash text NOT NULL,
    method text NOT NULL,
    path text NOT NULL,
    token_id bigint,
    state text NOT NULL,
    status_code integer,
    response_body text,
    response_content_type text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    completed_at timestamp with time zone,
    CONSTRAINT idempotency_keys_key_check CHECK (((length(key) >= 1) AND (length(key) <= 255))),
    CONSTRAINT idempotency_keys_state_check CHECK ((state = ANY (ARRAY['in_progress'::text, 'completed'::text])))
);

--
-- Name: labelled_names; Type: TABLE
--

CREATE TABLE public.labelled_names (
    domain text NOT NULL,
    role text NOT NULL,
    label text NOT NULL,
    source text NOT NULL,
    slice text NOT NULL,
    report_lane text,
    price_cents integer,
    as_of date,
    features jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    audit_id text,
    CONSTRAINT labelled_names_domain_check CHECK ((domain = lower(domain))),
    CONSTRAINT labelled_names_label_check CHECK ((label = ANY (ARRAY['sold'::text, 'dropped'::text]))),
    CONSTRAINT labelled_names_price_cents_check CHECK ((price_cents > 0)),
    CONSTRAINT labelled_names_report_lane_check CHECK ((report_lane = ANY (ARRAY['expired'::text, 'fresh'::text, 'aged'::text, 'geo'::text]))),
    CONSTRAINT labelled_names_role_check CHECK ((role = ANY (ARRAY['fit'::text, 'dev'::text, 'test'::text])))
);

--
-- Name: ledger_entries; Type: TABLE
--

CREATE TABLE public.ledger_entries (
    id bigint NOT NULL,
    occurred_on date NOT NULL,
    domain_id bigint,
    deal_id text,
    type text NOT NULL,
    amount_cents integer NOT NULL,
    currency text DEFAULT 'USD'::text NOT NULL,
    counterparty text,
    receipt_ref text,
    note text,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT ledger_entries_amount_cents_check CHECK ((amount_cents <> 0)),
    CONSTRAINT ledger_entries_currency_check CHECK ((currency = 'USD'::text)),
    CONSTRAINT ledger_entries_type_check CHECK ((type = ANY (ARRAY['registration'::text, 'renewal'::text, 'fee'::text, 'commission'::text, 'sale'::text, 'payout_fee'::text, 'refund'::text, 'tool'::text, 'ai'::text, 'adjustment'::text])))
);

--
-- Name: ledger_entries_id_seq; Type: SEQUENCE
--

ALTER TABLE public.ledger_entries ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.ledger_entries_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: listing_history; Type: TABLE
--

CREATE TABLE public.listing_history (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    at timestamp with time zone DEFAULT now() NOT NULL,
    source text NOT NULL,
    category text,
    mode text,
    bin_cents integer,
    floor_cents integer,
    min_offer_cents integer,
    lto_max_months smallint,
    lander text,
    override boolean DEFAULT false NOT NULL,
    override_reason text,
    approval_text text,
    approval_at timestamp with time zone,
    audit_id text,
    price_grade text,
    walkaway_cents integer,
    pricing_source text,
    pricing_settings_version integer,
    schedule_event_id bigint,
    plan_audit_id text,
    CONSTRAINT listing_history_bin_cents_check CHECK ((bin_cents > 0)),
    CONSTRAINT listing_history_category_check CHECK ((category = ANY (ARRAY['geo'::text, 'trend'::text, 'b2b'::text, 'collision'::text, 'regulation'::text, 'buzzword'::text, 'other'::text]))),
    CONSTRAINT listing_history_floor_cents_check CHECK ((floor_cents > 0)),
    CONSTRAINT listing_history_lto_max_months_check CHECK (((lto_max_months >= 2) AND (lto_max_months <= 60))),
    CONSTRAINT listing_history_min_offer_cents_check CHECK ((min_offer_cents >= 2000)),
    CONSTRAINT listing_history_mode_check CHECK ((mode = ANY (ARRAY['bin'::text, 'offer'::text, 'hybrid'::text]))),
    CONSTRAINT listing_history_price_grade_check CHECK ((price_grade = ANY (ARRAY['strong'::text, 'weaker'::text]))),
    CONSTRAINT listing_history_pricing_source_check CHECK ((pricing_source = ANY (ARRAY['formula'::text, 'approved_exception'::text]))),
    CONSTRAINT listing_history_source_check CHECK ((source = ANY (ARRAY['buy'::text, 'import'::text, 'list'::text, 'schedule'::text]))),
    CONSTRAINT listing_history_walkaway_cents_check CHECK ((walkaway_cents > 0))
);

--
-- Name: listing_history_id_seq; Type: SEQUENCE
--

ALTER TABLE public.listing_history ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.listing_history_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: manual_quotes; Type: TABLE
--

CREATE TABLE public.manual_quotes (
    id bigint NOT NULL,
    domain text NOT NULL,
    registrar text NOT NULL,
    renewal_cents integer NOT NULL,
    first_year_cents integer,
    source_url text,
    source_note text NOT NULL,
    observed_at timestamp with time zone NOT NULL,
    recorded_by text NOT NULL,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT manual_quotes_domain_check CHECK ((domain = lower(domain))),
    CONSTRAINT manual_quotes_first_year_cents_check CHECK ((first_year_cents > 0)),
    CONSTRAINT manual_quotes_renewal_cents_check CHECK ((renewal_cents > 0))
);

--
-- Name: manual_quotes_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.manual_quotes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: manual_quotes_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.manual_quotes_id_seq OWNED BY public.manual_quotes.id;

--
-- Name: offers; Type: TABLE
--

CREATE TABLE public.offers (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    amount_cents integer NOT NULL,
    source text NOT NULL,
    received_at timestamp with time zone NOT NULL,
    buyer_type text DEFAULT 'unknown'::text NOT NULL,
    buyer_ref text,
    external_ref text,
    bin_cents_at integer,
    floor_cents_at integer,
    walkaway_cents_at integer,
    min_offer_cents_at integer,
    listing_history_id bigint,
    band text NOT NULL,
    routing text NOT NULL,
    outcome text NOT NULL,
    outcome_at timestamp with time zone,
    outcome_note text,
    outcome_approval_text text,
    note text,
    recorded_by text NOT NULL,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT offers_amount_cents_check CHECK ((amount_cents > 0)),
    CONSTRAINT offers_band_check CHECK ((band = ANY (ARRAY['below_min'::text, 'below_walkaway'::text, 'mid_range'::text, 'at_or_above_floor'::text, 'at_or_above_bin'::text, 'geo_below_bin'::text, 'unpriced'::text]))),
    CONSTRAINT offers_buyer_ref_check CHECK (((buyer_ref IS NULL) OR (POSITION(('@'::text) IN (buyer_ref)) = 0))),
    CONSTRAINT offers_buyer_type_check CHECK ((buyer_type = ANY (ARRAY['end_user'::text, 'investor'::text, 'broker'::text, 'unknown'::text]))),
    CONSTRAINT offers_note_check CHECK (((note IS NULL) OR (POSITION(('@'::text) IN (note)) = 0))),
    CONSTRAINT offers_outcome_check CHECK ((outcome = ANY (ARRAY['declined_auto'::text, 'open'::text, 'declined'::text, 'countered'::text, 'accepted'::text, 'expired'::text, 'withdrawn'::text, 'sold'::text]))),
    CONSTRAINT offers_outcome_note_check CHECK (((outcome_note IS NULL) OR (POSITION(('@'::text) IN (outcome_note)) = 0))),
    CONSTRAINT offers_routing_check CHECK ((routing = ANY (ARRAY['auto_decline'::text, 'dvir'::text, 'auto_accept'::text, 'accept_preapproved'::text]))),
    CONSTRAINT offers_source_check CHECK ((source = ANY (ARRAY['afternic'::text, 'godaddy'::text, 'sedo'::text, 'domainagents'::text, 'email_inbound'::text, 'outbound_reply'::text, 'other'::text])))
);

--
-- Name: offers_id_seq; Type: SEQUENCE
--

ALTER TABLE public.offers ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.offers_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--

CREATE TABLE public.price_schedule (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    plan_id text NOT NULL,
    event text NOT NULL,
    due_on date NOT NULL,
    bin_cents integer,
    floor_cents integer,
    walkaway_cents integer,
    settings_version integer NOT NULL,
    status text NOT NULL,
    applied_at timestamp with time zone,
    listing_history_id bigint,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT price_schedule_bin_cents_check CHECK ((bin_cents > 0)),
    CONSTRAINT price_schedule_event_check CHECK ((event = ANY (ARRAY['drop1_m6'::text, 'drop2_m18'::text, 'geo_drop_m12'::text, 'final_push'::text, 'delist'::text]))),
    CONSTRAINT price_schedule_floor_cents_check CHECK ((floor_cents > 0)),
    CONSTRAINT price_schedule_planned_shape CHECK (((status <> 'planned'::text) OR ((event = 'delist'::text) AND (bin_cents IS NULL) AND (floor_cents IS NULL) AND (walkaway_cents IS NULL)) OR ((event <> 'delist'::text) AND (bin_cents IS NOT NULL) AND (floor_cents IS NOT NULL) AND (walkaway_cents IS NOT NULL) AND (walkaway_cents <= floor_cents) AND (floor_cents <= bin_cents)))),
    CONSTRAINT price_schedule_status_check CHECK ((status = ANY (ARRAY['planned'::text, 'applied'::text, 'skipped_at_minimum'::text, 'skipped_no_change'::text, 'skipped_disabled'::text, 'superseded'::text, 'superseded_by_final_push'::text, 'cancelled'::text, 'failed'::text]))),
    CONSTRAINT price_schedule_walkaway_cents_check CHECK ((walkaway_cents > 0))
);

--
-- Name: price_schedule_id_seq; Type: SEQUENCE
--

ALTER TABLE public.price_schedule ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.price_schedule_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: pricing_evidence; Type: TABLE
--

CREATE TABLE public.pricing_evidence (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    comps jsonb,
    rationale text,
    legacy_no_comps_reason text,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT pricing_evidence_check CHECK (((comps IS NOT NULL) OR (legacy_no_comps_reason IS NOT NULL)))
);

--
-- Name: pricing_evidence_id_seq; Type: SEQUENCE
--

ALTER TABLE public.pricing_evidence ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.pricing_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: pricing_settings; Type: TABLE
--

CREATE TABLE public.pricing_settings (
    version integer NOT NULL,
    effective_at timestamp with time zone NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    approval_text text NOT NULL,
    approval_at timestamp with time zone NOT NULL,
    note text,
    geo_bin_strong_cents integer NOT NULL,
    geo_bin_weaker_cents integer NOT NULL,
    geo_bin_min_cents integer NOT NULL,
    geo_bin_max_cents integer NOT NULL,
    geo_drops_enabled boolean NOT NULL,
    geo_drops jsonb NOT NULL,
    floor_bps integer NOT NULL,
    floor_min_cents integer NOT NULL,
    walkaway_bps integer NOT NULL,
    walkaway_min_cents integer NOT NULL,
    hybrid_min_offer_cents integer NOT NULL,
    drops jsonb NOT NULL,
    final_push_days_before_drop integer NOT NULL,
    final_push_mode text NOT NULL,
    delist_days_before_drop integer NOT NULL,
    headsup_days_before integer NOT NULL,
    comps_min integer NOT NULL,
    comps_max integer NOT NULL,
    public_lto boolean NOT NULL,
    allowed_bins_cents integer[],
    nongeo_bin_min_cents integer,
    nongeo_default_bin_cents integer,
    lander_exception_bins_cents integer[] DEFAULT '{}'::integer[] NOT NULL,
    floor_rounding text DEFAULT 'round5'::text NOT NULL,
    drop_mode text DEFAULT 'pct'::text NOT NULL,
    CONSTRAINT pricing_settings_approval_text_check CHECK ((length(TRIM(BOTH FROM approval_text)) > 0)),
    CONSTRAINT pricing_settings_check CHECK (((geo_bin_min_cents <= geo_bin_weaker_cents) AND (geo_bin_weaker_cents <= geo_bin_strong_cents) AND (geo_bin_strong_cents <= geo_bin_max_cents))),
    CONSTRAINT pricing_settings_check1 CHECK ((walkaway_bps <= floor_bps)),
    CONSTRAINT pricing_settings_check2 CHECK ((walkaway_min_cents <= floor_min_cents)),
    CONSTRAINT pricing_settings_check3 CHECK ((comps_min <= comps_max)),
    CONSTRAINT pricing_settings_check4 CHECK ((final_push_days_before_drop > delist_days_before_drop)),
    CONSTRAINT pricing_settings_comps_min_check CHECK ((comps_min >= 1)),
    CONSTRAINT pricing_settings_delist_days_before_drop_check CHECK ((delist_days_before_drop > 0)),
    CONSTRAINT pricing_settings_drop_mode_check CHECK ((drop_mode = ANY (ARRAY['pct'::text, 'ladder'::text]))),
    CONSTRAINT pricing_settings_final_push_days_before_drop_check CHECK ((final_push_days_before_drop > 0)),
    CONSTRAINT pricing_settings_final_push_mode_check CHECK ((final_push_mode = ANY (ARRAY['bin_to_floor_ceil95'::text, 'bin_to_lowest_listed_ge_floor'::text]))),
    CONSTRAINT pricing_settings_floor_bps_check CHECK (((floor_bps >= 1) AND (floor_bps <= 10000))),
    CONSTRAINT pricing_settings_floor_min_cents_check CHECK ((floor_min_cents > 0)),
    CONSTRAINT pricing_settings_floor_rounding_check CHECK ((floor_rounding = ANY (ARRAY['round5'::text, 'dollar'::text]))),
    CONSTRAINT pricing_settings_geo_bin_min_cents_check CHECK ((geo_bin_min_cents > 0)),
    CONSTRAINT pricing_settings_geo_bin_strong_cents_check CHECK ((geo_bin_strong_cents > 0)),
    CONSTRAINT pricing_settings_geo_bin_weaker_cents_check CHECK ((geo_bin_weaker_cents > 0)),
    CONSTRAINT pricing_settings_headsup_days_before_check CHECK ((headsup_days_before >= 0)),
    CONSTRAINT pricing_settings_hybrid_min_offer_cents_check CHECK ((hybrid_min_offer_cents >= 2000)),
    CONSTRAINT pricing_settings_v3_shape CHECK ((((drop_mode = 'pct'::text) AND (allowed_bins_cents IS NULL)) OR ((drop_mode = 'ladder'::text) AND (allowed_bins_cents IS NOT NULL) AND (nongeo_bin_min_cents IS NOT NULL) AND (nongeo_default_bin_cents IS NOT NULL)))),
    CONSTRAINT pricing_settings_version_check CHECK ((version >= 1)),
    CONSTRAINT pricing_settings_walkaway_bps_check CHECK (((walkaway_bps >= 1) AND (walkaway_bps <= 10000))),
    CONSTRAINT pricing_settings_walkaway_min_cents_check CHECK ((walkaway_min_cents > 0))
);

--
-- Name: purchases; Type: TABLE
--

CREATE TABLE public.purchases (
    id bigint NOT NULL,
    idempotency_key text NOT NULL,
    request_hash text NOT NULL,
    domain text NOT NULL,
    state text NOT NULL,
    dry_run boolean DEFAULT false NOT NULL,
    registrar text,
    check_id text,
    charged_cents integer,
    order_id text,
    max_price_cents integer NOT NULL,
    approval_text text NOT NULL,
    approval_at timestamp with time zone NOT NULL,
    response jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    expected_cents integer,
    request jsonb,
    audit_id text,
    CONSTRAINT purchases_charged_cents_check CHECK ((charged_cents >= 0)),
    CONSTRAINT purchases_domain_check CHECK ((domain = lower(domain))),
    CONSTRAINT purchases_expected_cents_check CHECK ((expected_cents > 0)),
    CONSTRAINT purchases_max_price_cents_check CHECK ((max_price_cents > 0)),
    CONSTRAINT purchases_registrar_check CHECK ((lower(registrar) <> 'cloudflare'::text)),
    CONSTRAINT purchases_state_check CHECK ((state = ANY (ARRAY['created'::text, 'register_sent'::text, 'succeeded'::text, 'failed'::text, 'unknown'::text])))
);

--
-- Name: purchases_id_seq; Type: SEQUENCE
--

ALTER TABLE public.purchases ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.purchases_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: quotes; Type: TABLE
--

CREATE TABLE public.quotes (
    id bigint NOT NULL,
    check_id text NOT NULL,
    domain text NOT NULL,
    registrar text NOT NULL,
    quoted_at timestamp with time zone DEFAULT now() NOT NULL,
    available boolean,
    premium boolean,
    first_year_cents integer,
    renewal_cents integer,
    privacy_cents_per_year integer,
    two_year_cents integer,
    eligible boolean NOT NULL,
    exclusion_reason text,
    raw jsonb,
    CONSTRAINT quotes_domain_check CHECK ((domain = lower(domain)))
);

--
-- Name: quotes_id_seq; Type: SEQUENCE
--

ALTER TABLE public.quotes ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.quotes_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: rdap_lookups; Type: TABLE
--

CREATE TABLE public.rdap_lookups (
    id bigint NOT NULL,
    domain text NOT NULL,
    outcome text NOT NULL,
    reason_code text,
    http_status integer,
    facts jsonb,
    evidence_id bigint,
    checked_at timestamp with time zone NOT NULL,
    CONSTRAINT rdap_lookups_outcome_check CHECK ((outcome = ANY (ARRAY['registered'::text, 'not_registered'::text, 'unknown'::text])))
);

--
-- Name: rdap_lookups_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.rdap_lookups_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: rdap_lookups_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.rdap_lookups_id_seq OWNED BY public.rdap_lookups.id;

--
-- Name: receipts; Type: TABLE
--

CREATE TABLE public.receipts (
    id bigint NOT NULL,
    purchase_id bigint,
    registrar text NOT NULL,
    order_id text NOT NULL,
    raw jsonb,
    fetched_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: receipts_id_seq; Type: SEQUENCE
--

ALTER TABLE public.receipts ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.receipts_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: reference_files; Type: TABLE
--

CREATE TABLE public.reference_files (
    id bigint NOT NULL,
    name text NOT NULL,
    source_url text NOT NULL,
    fetched_at timestamp with time zone NOT NULL,
    data_date date,
    sha256 character(64) NOT NULL,
    bytes integer NOT NULL,
    body_gz bytea,
    same_as_id bigint
);

--
-- Name: reference_files_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.reference_files_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: reference_files_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.reference_files_id_seq OWNED BY public.reference_files.id;

--
-- Name: registrar_presence; Type: TABLE
--

CREATE TABLE public.registrar_presence (
    domain_id bigint NOT NULL,
    status text NOT NULL,
    first_absent_at timestamp with time zone,
    last_checked_at timestamp with time zone NOT NULL,
    CONSTRAINT registrar_presence_absent_since CHECK (((status = 'absent'::text) = (first_absent_at IS NOT NULL))),
    CONSTRAINT registrar_presence_status_check CHECK ((status = ANY (ARRAY['present'::text, 'absent'::text])))
);

--
-- Name: replay_runs; Type: TABLE
--

CREATE TABLE public.replay_runs (
    id text NOT NULL,
    suite text NOT NULL,
    mode text NOT NULL,
    settings_id integer NOT NULL,
    settings_label text NOT NULL,
    suite_def_id integer,
    filter jsonb NOT NULL,
    report jsonb NOT NULL,
    leakage_rows integer NOT NULL,
    pass boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    audit_id text,
    CONSTRAINT replay_runs_check CHECK (((mode = 'holdout'::text) OR (pass = false))),
    CONSTRAINT replay_runs_check1 CHECK (((mode = 'holdout'::text) = (suite_def_id IS NOT NULL))),
    CONSTRAINT replay_runs_id_check CHECK ((id ~ '^rpl_[0-9a-f]{12}$'::text)),
    CONSTRAINT replay_runs_mode_check CHECK ((mode = ANY (ARRAY['diagnostic'::text, 'holdout'::text])))
);

--
-- Name: sales; Type: TABLE
--

CREATE TABLE public.sales (
    id bigint NOT NULL,
    domain_id bigint NOT NULL,
    sale_ledger_id bigint NOT NULL,
    venue text NOT NULL,
    transaction_ref text,
    sale_price_cents integer NOT NULL,
    commission_cents integer NOT NULL,
    other_fees_cents integer DEFAULT 0 NOT NULL,
    sold_at timestamp with time zone NOT NULL,
    offer_id bigint,
    evidence_source text,
    evidence_ref text,
    approval_text text,
    approval_at timestamp with time zone,
    recorded_by text NOT NULL,
    confirmed boolean DEFAULT false NOT NULL,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT sales_evidence_or_approval CHECK ((confirmed OR ((evidence_source IS NOT NULL) AND (evidence_ref IS NOT NULL) AND (transaction_ref IS NOT NULL)))),
    CONSTRAINT sales_evidence_ref_check CHECK (((evidence_ref IS NULL) OR (length(TRIM(BOTH FROM evidence_ref)) > 0))),
    CONSTRAINT sales_evidence_source_check CHECK ((evidence_source = ANY (ARRAY['afternic_email'::text, 'sedo_email'::text, 'afternic_dashboard'::text, 'sedo_dashboard'::text, 'escrow'::text, 'other'::text]))),
    CONSTRAINT sales_transaction_ref_check CHECK (((transaction_ref IS NULL) OR (POSITION(('@'::text) IN (transaction_ref)) = 0)))
);

--
-- Name: sales_id_seq; Type: SEQUENCE
--

ALTER TABLE public.sales ALTER COLUMN id ADD GENERATED ALWAYS AS IDENTITY (
    SEQUENCE NAME public.sales_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);

--
-- Name: screening_evidence; Type: TABLE
--

CREATE TABLE public.screening_evidence (
    id bigint NOT NULL,
    source text NOT NULL,
    url text NOT NULL,
    retrieved_at timestamp with time zone NOT NULL,
    http_status integer,
    sha256 character(64) NOT NULL,
    content_type text,
    text_gz bytea,
    text_bytes integer NOT NULL,
    truncated boolean NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);

--
-- Name: screening_evidence_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.screening_evidence_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: screening_evidence_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.screening_evidence_id_seq OWNED BY public.screening_evidence.id;

--
-- Name: screening_results; Type: TABLE
--

CREATE TABLE public.screening_results (
    id bigint NOT NULL,
    run_id text NOT NULL,
    item_idx smallint NOT NULL,
    domain text NOT NULL,
    lane text NOT NULL,
    check_id text NOT NULL,
    gate text NOT NULL,
    rule_ids text[] NOT NULL,
    status text NOT NULL,
    reason_code text,
    reason text,
    fields jsonb NOT NULL,
    data_as_of timestamp with time zone,
    checked_at timestamp with time zone NOT NULL,
    settings_label text NOT NULL,
    list_versions jsonb NOT NULL,
    duration_ms integer NOT NULL,
    upstream_calls integer NOT NULL,
    evidence_ids bigint[] DEFAULT '{}'::bigint[] NOT NULL,
    source text NOT NULL,
    cached_from bigint,
    recorded_by text,
    audit_id text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT screening_results_check CHECK (((status = 'PASS'::text) OR (reason_code IS NOT NULL))),
    CONSTRAINT screening_results_source_check CHECK ((source = ANY (ARRAY['auto'::text, 'cache'::text, 'manual'::text]))),
    CONSTRAINT screening_results_status_check CHECK ((status = ANY (ARRAY['PASS'::text, 'PASS_WITH_NOTE'::text, 'FLAG'::text, 'FAIL'::text, 'UNKNOWN'::text, 'MANUAL_REQUIRED'::text, 'NOT_RUN'::text])))
);

--
-- Name: screening_results_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.screening_results_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: screening_results_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.screening_results_id_seq OWNED BY public.screening_results.id;

--
-- Name: screening_runs; Type: TABLE
--

CREATE TABLE public.screening_runs (
    id text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    audit_id text,
    mode text NOT NULL,
    backtest boolean NOT NULL,
    settings_id integer NOT NULL,
    settings_label text NOT NULL,
    buy_hold boolean NOT NULL,
    tranche_id text,
    input jsonb NOT NULL,
    gate_plan jsonb NOT NULL,
    list_versions jsonb NOT NULL,
    status text NOT NULL,
    deadline_at timestamp with time zone NOT NULL,
    heartbeat_at timestamp with time zone,
    finished_at timestamp with time zone,
    summary jsonb,
    CONSTRAINT screening_runs_mode_check CHECK ((mode = ANY (ARRAY['live'::text, 'full'::text]))),
    CONSTRAINT screening_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'done'::text, 'partial'::text])))
);

--
-- Name: selection_lists; Type: TABLE
--

CREATE TABLE public.selection_lists (
    id integer NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    terms text[] NOT NULL,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    audit_id text,
    approval_text text,
    CONSTRAINT selection_lists_name_check CHECK ((name ~ '^[a-z0-9_]{3,64}$'::text)),
    CONSTRAINT selection_lists_version_check CHECK ((version >= 1))
);

--
-- Name: selection_lists_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.selection_lists_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: selection_lists_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.selection_lists_id_seq OWNED BY public.selection_lists.id;

--
-- Name: selection_settings; Type: TABLE
--

CREATE TABLE public.selection_settings (
    id integer NOT NULL,
    label text NOT NULL,
    "values" jsonb NOT NULL,
    based_on_id integer,
    note text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    created_by text NOT NULL,
    audit_id text,
    activation_seq integer,
    activated_at timestamp with time zone,
    activation_approval_text text,
    activation_approval_at timestamp with time zone,
    activated_by text,
    activation_audit_id text,
    CONSTRAINT selection_settings_check CHECK ((((activation_seq IS NULL) AND (activated_at IS NULL) AND (activation_approval_text IS NULL) AND (activation_approval_at IS NULL) AND (activated_by IS NULL)) OR ((activation_seq IS NOT NULL) AND (activated_at IS NOT NULL) AND (activation_approval_text IS NOT NULL) AND (activation_approval_at IS NOT NULL) AND (activated_by IS NOT NULL)))),
    CONSTRAINT selection_settings_label_check CHECK ((label ~ '^[a-z0-9][a-z0-9._-]{0,31}$'::text))
);

--
-- Name: selection_settings_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.selection_settings_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: selection_settings_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.selection_settings_id_seq OWNED BY public.selection_settings.id;

--
-- Name: settings; Type: TABLE
--

CREATE TABLE public.settings (
    id boolean DEFAULT true NOT NULL,
    poc_cap_cents integer DEFAULT 150000 NOT NULL,
    max_domains integer DEFAULT 50 NOT NULL,
    approval_max_age_hours integer DEFAULT 72 NOT NULL,
    lander_target text DEFAULT 'afternic'::text NOT NULL,
    allowed_registrars text[] DEFAULT '{porkbun}'::text[] NOT NULL,
    high_value_min_bin_cents integer DEFAULT 250000 NOT NULL,
    sedo_hybrid_as text DEFAULT 'make_offer'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT settings_allowed_registrars_check CHECK ((NOT ('cloudflare'::text = ANY ((lower((allowed_registrars)::text))::text[])))),
    CONSTRAINT settings_approval_max_age_hours_check CHECK ((approval_max_age_hours > 0)),
    CONSTRAINT settings_high_value_min_bin_cents_check CHECK ((high_value_min_bin_cents > 0)),
    CONSTRAINT settings_id_check CHECK (id),
    CONSTRAINT settings_lander_target_check CHECK ((lander_target = ANY (ARRAY['afternic'::text, 'sedo'::text, 'custom'::text]))),
    CONSTRAINT settings_max_domains_check CHECK ((max_domains > 0)),
    CONSTRAINT settings_poc_cap_cents_check CHECK ((poc_cap_cents > 0)),
    CONSTRAINT settings_sedo_hybrid_as_check CHECK ((sedo_hybrid_as = ANY (ARRAY['buy_now'::text, 'make_offer'::text])))
);

--
-- Name: tranche_members; Type: TABLE
--

CREATE TABLE public.tranche_members (
    id bigint NOT NULL,
    tranche_id text NOT NULL,
    domain text NOT NULL,
    lane text NOT NULL,
    is_geo boolean NOT NULL,
    main_lane boolean NOT NULL,
    est_cost_cents integer,
    run_id text NOT NULL,
    added_at timestamp with time zone DEFAULT now() NOT NULL,
    added_by text NOT NULL,
    removed_at timestamp with time zone,
    removed_by text,
    CONSTRAINT tranche_members_domain_check CHECK ((domain = lower(domain))),
    CONSTRAINT tranche_members_est_cost_cents_check CHECK ((est_cost_cents > 0))
);

--
-- Name: tranche_members_id_seq; Type: SEQUENCE
--

CREATE SEQUENCE public.tranche_members_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;

--
-- Name: tranche_members_id_seq; Type: SEQUENCE OWNED BY
--

ALTER SEQUENCE public.tranche_members_id_seq OWNED BY public.tranche_members.id;

--
-- Name: tranches; Type: TABLE
--

CREATE TABLE public.tranches (
    id text NOT NULL,
    name text NOT NULL,
    status text NOT NULL,
    opened_at timestamp with time zone DEFAULT now() NOT NULL,
    opened_by text NOT NULL,
    closed_at timestamp with time zone,
    closed_by text,
    settings_label text NOT NULL,
    spend_cap_cents integer,
    close_report jsonb,
    audit_id text,
    CONSTRAINT tranches_check CHECK (((status = 'closed'::text) = (closed_at IS NOT NULL))),
    CONSTRAINT tranches_id_check CHECK ((id ~ '^trn_[0-9a-f]{12}$'::text)),
    CONSTRAINT tranches_spend_cap_cents_check CHECK ((spend_cap_cents > 0)),
    CONSTRAINT tranches_status_check CHECK ((status = ANY (ARRAY['open'::text, 'closed'::text])))
);

--
-- Name: holdout_suites id; Type: DEFAULT
--

ALTER TABLE ONLY public.holdout_suites ALTER COLUMN id SET DEFAULT nextval('public.holdout_suites_id_seq'::regclass);

--
-- Name: manual_quotes id; Type: DEFAULT
--

ALTER TABLE ONLY public.manual_quotes ALTER COLUMN id SET DEFAULT nextval('public.manual_quotes_id_seq'::regclass);

--
-- Name: rdap_lookups id; Type: DEFAULT
--

ALTER TABLE ONLY public.rdap_lookups ALTER COLUMN id SET DEFAULT nextval('public.rdap_lookups_id_seq'::regclass);

--
-- Name: reference_files id; Type: DEFAULT
--

ALTER TABLE ONLY public.reference_files ALTER COLUMN id SET DEFAULT nextval('public.reference_files_id_seq'::regclass);

--
-- Name: screening_evidence id; Type: DEFAULT
--

ALTER TABLE ONLY public.screening_evidence ALTER COLUMN id SET DEFAULT nextval('public.screening_evidence_id_seq'::regclass);

--
-- Name: screening_results id; Type: DEFAULT
--

ALTER TABLE ONLY public.screening_results ALTER COLUMN id SET DEFAULT nextval('public.screening_results_id_seq'::regclass);

--
-- Name: selection_lists id; Type: DEFAULT
--

ALTER TABLE ONLY public.selection_lists ALTER COLUMN id SET DEFAULT nextval('public.selection_lists_id_seq'::regclass);

--
-- Name: selection_settings id; Type: DEFAULT
--

ALTER TABLE ONLY public.selection_settings ALTER COLUMN id SET DEFAULT nextval('public.selection_settings_id_seq'::regclass);

--
-- Name: tranche_members id; Type: DEFAULT
--

ALTER TABLE ONLY public.tranche_members ALTER COLUMN id SET DEFAULT nextval('public.tranche_members_id_seq'::regclass);

--
-- Name: api_tokens api_tokens_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_pkey PRIMARY KEY (id);

--
-- Name: api_tokens api_tokens_token_sha256_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.api_tokens
    ADD CONSTRAINT api_tokens_token_sha256_key UNIQUE (token_sha256);

--
-- Name: audit_log audit_log_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_pkey PRIMARY KEY (id);

--
-- Name: deals deals_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.deals
    ADD CONSTRAINT deals_pkey PRIMARY KEY (id);

--
-- Name: domains domains_domain_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_domain_key UNIQUE (domain);

--
-- Name: domains domains_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pkey PRIMARY KEY (id);

--
-- Name: export_runs export_runs_export_id_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.export_runs
    ADD CONSTRAINT export_runs_export_id_key UNIQUE (export_id);

--
-- Name: export_runs export_runs_export_id_marketplace_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.export_runs
    ADD CONSTRAINT export_runs_export_id_marketplace_key UNIQUE (export_id, marketplace);

--
-- Name: export_runs export_runs_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.export_runs
    ADD CONSTRAINT export_runs_pkey PRIMARY KEY (id);

--
-- Name: export_uploads export_uploads_export_id_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.export_uploads
    ADD CONSTRAINT export_uploads_export_id_key UNIQUE (export_id);

--
-- Name: export_uploads export_uploads_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.export_uploads
    ADD CONSTRAINT export_uploads_pkey PRIMARY KEY (id);

--
-- Name: holdout_suites holdout_suites_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.holdout_suites
    ADD CONSTRAINT holdout_suites_pkey PRIMARY KEY (id);

--
-- Name: holdout_suites holdout_suites_suite_version_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.holdout_suites
    ADD CONSTRAINT holdout_suites_suite_version_key UNIQUE (suite, version);

--
-- Name: idempotency_keys idempotency_keys_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_pkey PRIMARY KEY (key);

--
-- Name: labelled_names labelled_names_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.labelled_names
    ADD CONSTRAINT labelled_names_pkey PRIMARY KEY (domain);

--
-- Name: ledger_entries ledger_entries_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_pkey PRIMARY KEY (id);

--
-- Name: listing_history listing_history_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.listing_history
    ADD CONSTRAINT listing_history_pkey PRIMARY KEY (id);

--
-- Name: manual_quotes manual_quotes_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.manual_quotes
    ADD CONSTRAINT manual_quotes_pkey PRIMARY KEY (id);

--
-- Name: offers offers_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_pkey PRIMARY KEY (id);

--
-- Name: price_schedule price_schedule_domain_id_event_plan_id_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.price_schedule
    ADD CONSTRAINT price_schedule_domain_id_event_plan_id_key UNIQUE (domain_id, event, plan_id);

--
-- Name: price_schedule price_schedule_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.price_schedule
    ADD CONSTRAINT price_schedule_pkey PRIMARY KEY (id);

--
-- Name: pricing_evidence pricing_evidence_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.pricing_evidence
    ADD CONSTRAINT pricing_evidence_pkey PRIMARY KEY (id);

--
-- Name: pricing_settings pricing_settings_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.pricing_settings
    ADD CONSTRAINT pricing_settings_pkey PRIMARY KEY (version);

--
-- Name: purchases purchases_idempotency_key_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_idempotency_key_key UNIQUE (idempotency_key);

--
-- Name: purchases purchases_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.purchases
    ADD CONSTRAINT purchases_pkey PRIMARY KEY (id);

--
-- Name: quotes quotes_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.quotes
    ADD CONSTRAINT quotes_pkey PRIMARY KEY (id);

--
-- Name: rdap_lookups rdap_lookups_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.rdap_lookups
    ADD CONSTRAINT rdap_lookups_pkey PRIMARY KEY (id);

--
-- Name: receipts receipts_one_per_purchase; Type: CONSTRAINT
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_one_per_purchase UNIQUE (purchase_id);

--
-- Name: receipts receipts_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_pkey PRIMARY KEY (id);

--
-- Name: reference_files reference_files_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.reference_files
    ADD CONSTRAINT reference_files_pkey PRIMARY KEY (id);

--
-- Name: registrar_presence registrar_presence_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.registrar_presence
    ADD CONSTRAINT registrar_presence_pkey PRIMARY KEY (domain_id);

--
-- Name: replay_runs replay_runs_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.replay_runs
    ADD CONSTRAINT replay_runs_pkey PRIMARY KEY (id);

--
-- Name: sales sales_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_pkey PRIMARY KEY (id);

--
-- Name: sales sales_sale_ledger_id_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_sale_ledger_id_key UNIQUE (sale_ledger_id);

--
-- Name: sales sales_venue_transaction_ref_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_venue_transaction_ref_key UNIQUE (venue, transaction_ref);

--
-- Name: screening_evidence screening_evidence_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.screening_evidence
    ADD CONSTRAINT screening_evidence_pkey PRIMARY KEY (id);

--
-- Name: screening_results screening_results_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.screening_results
    ADD CONSTRAINT screening_results_pkey PRIMARY KEY (id);

--
-- Name: screening_runs screening_runs_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_pkey PRIMARY KEY (id);

--
-- Name: selection_lists selection_lists_name_version_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.selection_lists
    ADD CONSTRAINT selection_lists_name_version_key UNIQUE (name, version);

--
-- Name: selection_lists selection_lists_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.selection_lists
    ADD CONSTRAINT selection_lists_pkey PRIMARY KEY (id);

--
-- Name: selection_settings selection_settings_activation_seq_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.selection_settings
    ADD CONSTRAINT selection_settings_activation_seq_key UNIQUE (activation_seq);

--
-- Name: selection_settings selection_settings_label_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.selection_settings
    ADD CONSTRAINT selection_settings_label_key UNIQUE (label);

--
-- Name: selection_settings selection_settings_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.selection_settings
    ADD CONSTRAINT selection_settings_pkey PRIMARY KEY (id);

--
-- Name: settings settings_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.settings
    ADD CONSTRAINT settings_pkey PRIMARY KEY (id);

--
-- Name: tranche_members tranche_members_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.tranche_members
    ADD CONSTRAINT tranche_members_pkey PRIMARY KEY (id);

--
-- Name: tranches tranches_name_key; Type: CONSTRAINT
--

ALTER TABLE ONLY public.tranches
    ADD CONSTRAINT tranches_name_key UNIQUE (name);

--
-- Name: tranches tranches_pkey; Type: CONSTRAINT
--

ALTER TABLE ONLY public.tranches
    ADD CONSTRAINT tranches_pkey PRIMARY KEY (id);

--
-- Name: api_tokens_active_name; Type: INDEX
--

CREATE UNIQUE INDEX api_tokens_active_name ON public.api_tokens USING btree (name) WHERE (revoked_at IS NULL);

--
-- Name: audit_log_at; Type: INDEX
--

CREATE INDEX audit_log_at ON public.audit_log USING btree (at);

--
-- Name: export_runs_marketplace_at; Type: INDEX
--

CREATE INDEX export_runs_marketplace_at ON public.export_runs USING btree (marketplace, at);

--
-- Name: export_uploads_venue_at; Type: INDEX
--

CREATE INDEX export_uploads_venue_at ON public.export_uploads USING btree (venue, uploaded_at);

--
-- Name: ledger_entries_domain; Type: INDEX
--

CREATE INDEX ledger_entries_domain ON public.ledger_entries USING btree (domain_id);

--
-- Name: listing_history_domain; Type: INDEX
--

CREATE INDEX listing_history_domain ON public.listing_history USING btree (domain_id, at);

--
-- Name: manual_quotes_domain; Type: INDEX
--

CREATE INDEX manual_quotes_domain ON public.manual_quotes USING btree (domain, observed_at DESC);

--
-- Name: offers_domain_received; Type: INDEX
--

CREATE INDEX offers_domain_received ON public.offers USING btree (domain_id, received_at DESC);

--
-- Name: offers_natural_key; Type: INDEX
--

CREATE UNIQUE INDEX offers_natural_key ON public.offers USING btree (domain_id, amount_cents, source, received_at) WHERE (external_ref IS NULL);

--
-- Name: offers_source_external_ref; Type: INDEX
--

CREATE UNIQUE INDEX offers_source_external_ref ON public.offers USING btree (source, external_ref) WHERE (external_ref IS NOT NULL);

--
-- Name: one_open_tranche; Type: INDEX
--

CREATE UNIQUE INDEX one_open_tranche ON public.tranches USING btree ((true)) WHERE (status = 'open'::text);

--
-- Name: price_schedule_due; Type: INDEX
--

CREATE INDEX price_schedule_due ON public.price_schedule USING btree (status, due_on);

--
-- Name: purchases_one_open_per_domain; Type: INDEX
--

CREATE UNIQUE INDEX purchases_one_open_per_domain ON public.purchases USING btree (domain) WHERE (state = ANY (ARRAY['created'::text, 'register_sent'::text, 'succeeded'::text, 'unknown'::text]));

--
-- Name: purchases_open_state; Type: INDEX
--

CREATE INDEX purchases_open_state ON public.purchases USING btree (state) WHERE (state = ANY (ARRAY['created'::text, 'register_sent'::text, 'unknown'::text]));

--
-- Name: quotes_check; Type: INDEX
--

CREATE INDEX quotes_check ON public.quotes USING btree (check_id);

--
-- Name: quotes_domain; Type: INDEX
--

CREATE INDEX quotes_domain ON public.quotes USING btree (domain, quoted_at);

--
-- Name: rdap_lookups_domain; Type: INDEX
--

CREATE INDEX rdap_lookups_domain ON public.rdap_lookups USING btree (domain, checked_at DESC);

--
-- Name: reference_files_name; Type: INDEX
--

CREATE INDEX reference_files_name ON public.reference_files USING btree (name, fetched_at DESC);

--
-- Name: replay_runs_suite; Type: INDEX
--

CREATE INDEX replay_runs_suite ON public.replay_runs USING btree (suite, settings_id, created_at DESC);

--
-- Name: screening_results_domain_check; Type: INDEX
--

CREATE INDEX screening_results_domain_check ON public.screening_results USING btree (domain, check_id, checked_at DESC);

--
-- Name: screening_results_once; Type: INDEX
--

CREATE UNIQUE INDEX screening_results_once ON public.screening_results USING btree (run_id, item_idx, check_id) WHERE (source <> 'manual'::text);

--
-- Name: screening_runs_running; Type: INDEX
--

CREATE INDEX screening_runs_running ON public.screening_runs USING btree (status) WHERE (status = 'running'::text);

--
-- Name: tranche_members_active; Type: INDEX
--

CREATE UNIQUE INDEX tranche_members_active ON public.tranche_members USING btree (tranche_id, domain) WHERE (removed_at IS NULL);

--
-- Name: audit_log audit_log_append_only; Type: TRIGGER
--

CREATE TRIGGER audit_log_append_only BEFORE DELETE OR UPDATE ON public.audit_log FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: audit_log audit_log_no_truncate; Type: TRIGGER
--

CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON public.audit_log FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: export_uploads export_uploads_append_only; Type: TRIGGER
--

CREATE TRIGGER export_uploads_append_only BEFORE DELETE OR UPDATE ON public.export_uploads FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: export_uploads export_uploads_no_truncate; Type: TRIGGER
--

CREATE TRIGGER export_uploads_no_truncate BEFORE TRUNCATE ON public.export_uploads FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: holdout_suites holdout_suites_append_only; Type: TRIGGER
--

CREATE TRIGGER holdout_suites_append_only BEFORE DELETE OR UPDATE ON public.holdout_suites FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: holdout_suites holdout_suites_no_truncate; Type: TRIGGER
--

CREATE TRIGGER holdout_suites_no_truncate BEFORE TRUNCATE ON public.holdout_suites FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: labelled_names labelled_names_append_only; Type: TRIGGER
--

CREATE TRIGGER labelled_names_append_only BEFORE DELETE OR UPDATE ON public.labelled_names FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: labelled_names labelled_names_no_truncate; Type: TRIGGER
--

CREATE TRIGGER labelled_names_no_truncate BEFORE TRUNCATE ON public.labelled_names FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: ledger_entries ledger_entries_append_only; Type: TRIGGER
--

CREATE TRIGGER ledger_entries_append_only BEFORE DELETE OR UPDATE ON public.ledger_entries FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: ledger_entries ledger_entries_no_truncate; Type: TRIGGER
--

CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: listing_history listing_history_append_only; Type: TRIGGER
--

CREATE TRIGGER listing_history_append_only BEFORE DELETE OR UPDATE ON public.listing_history FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: listing_history listing_history_no_truncate; Type: TRIGGER
--

CREATE TRIGGER listing_history_no_truncate BEFORE TRUNCATE ON public.listing_history FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: manual_quotes manual_quotes_append_only; Type: TRIGGER
--

CREATE TRIGGER manual_quotes_append_only BEFORE DELETE OR UPDATE ON public.manual_quotes FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: manual_quotes manual_quotes_no_truncate; Type: TRIGGER
--

CREATE TRIGGER manual_quotes_no_truncate BEFORE TRUNCATE ON public.manual_quotes FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: offers offers_immutable; Type: TRIGGER
--

CREATE TRIGGER offers_immutable BEFORE DELETE OR UPDATE ON public.offers FOR EACH ROW EXECUTE FUNCTION public.offers_facts_immutable();

--
-- Name: offers offers_no_truncate; Type: TRIGGER
--

CREATE TRIGGER offers_no_truncate BEFORE TRUNCATE ON public.offers FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: pricing_evidence pricing_evidence_append_only; Type: TRIGGER
--

CREATE TRIGGER pricing_evidence_append_only BEFORE DELETE OR UPDATE ON public.pricing_evidence FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: pricing_evidence pricing_evidence_no_truncate; Type: TRIGGER
--

CREATE TRIGGER pricing_evidence_no_truncate BEFORE TRUNCATE ON public.pricing_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: pricing_settings pricing_settings_append_only; Type: TRIGGER
--

CREATE TRIGGER pricing_settings_append_only BEFORE DELETE OR UPDATE ON public.pricing_settings FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: pricing_settings pricing_settings_no_truncate; Type: TRIGGER
--

CREATE TRIGGER pricing_settings_no_truncate BEFORE TRUNCATE ON public.pricing_settings FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: replay_runs replay_runs_append_only; Type: TRIGGER
--

CREATE TRIGGER replay_runs_append_only BEFORE DELETE OR UPDATE ON public.replay_runs FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: replay_runs replay_runs_no_truncate; Type: TRIGGER
--

CREATE TRIGGER replay_runs_no_truncate BEFORE TRUNCATE ON public.replay_runs FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: sales sales_append_only; Type: TRIGGER
--

CREATE TRIGGER sales_append_only BEFORE DELETE OR UPDATE ON public.sales FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: sales sales_no_truncate; Type: TRIGGER
--

CREATE TRIGGER sales_no_truncate BEFORE TRUNCATE ON public.sales FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: screening_evidence screening_evidence_append_only; Type: TRIGGER
--

CREATE TRIGGER screening_evidence_append_only BEFORE DELETE OR UPDATE ON public.screening_evidence FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: screening_evidence screening_evidence_no_truncate; Type: TRIGGER
--

CREATE TRIGGER screening_evidence_no_truncate BEFORE TRUNCATE ON public.screening_evidence FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: screening_results screening_results_append_only; Type: TRIGGER
--

CREATE TRIGGER screening_results_append_only BEFORE DELETE OR UPDATE ON public.screening_results FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: screening_results screening_results_no_truncate; Type: TRIGGER
--

CREATE TRIGGER screening_results_no_truncate BEFORE TRUNCATE ON public.screening_results FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: selection_lists selection_lists_append_only; Type: TRIGGER
--

CREATE TRIGGER selection_lists_append_only BEFORE DELETE OR UPDATE ON public.selection_lists FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: selection_lists selection_lists_no_truncate; Type: TRIGGER
--

CREATE TRIGGER selection_lists_no_truncate BEFORE TRUNCATE ON public.selection_lists FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: selection_settings selection_settings_append_only; Type: TRIGGER
--

CREATE TRIGGER selection_settings_append_only BEFORE DELETE OR UPDATE ON public.selection_settings FOR EACH ROW EXECUTE FUNCTION public.selection_settings_guard();

--
-- Name: selection_settings selection_settings_no_truncate; Type: TRIGGER
--

CREATE TRIGGER selection_settings_no_truncate BEFORE TRUNCATE ON public.selection_settings FOR EACH STATEMENT EXECUTE FUNCTION public.reject_mutation();

--
-- Name: tranche_members tranche_members_no_delete; Type: TRIGGER
--

CREATE TRIGGER tranche_members_no_delete BEFORE DELETE ON public.tranche_members FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: tranche_members tranche_members_read_only; Type: TRIGGER
--

CREATE TRIGGER tranche_members_read_only BEFORE UPDATE ON public.tranche_members FOR EACH ROW EXECUTE FUNCTION public.tranche_members_guard_update();

--
-- Name: tranches tranches_closed_read_only; Type: TRIGGER
--

CREATE TRIGGER tranches_closed_read_only BEFORE UPDATE ON public.tranches FOR EACH ROW EXECUTE FUNCTION public.tranches_guard_update();

--
-- Name: tranches tranches_no_delete; Type: TRIGGER
--

CREATE TRIGGER tranches_no_delete BEFORE DELETE ON public.tranches FOR EACH ROW EXECUTE FUNCTION public.reject_mutation();

--
-- Name: audit_log audit_log_token_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.audit_log
    ADD CONSTRAINT audit_log_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.api_tokens(id);

--
-- Name: domains domains_pricing_settings_version_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.domains
    ADD CONSTRAINT domains_pricing_settings_version_fkey FOREIGN KEY (pricing_settings_version) REFERENCES public.pricing_settings(version);

--
-- Name: export_uploads export_uploads_run_fk; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.export_uploads
    ADD CONSTRAINT export_uploads_run_fk FOREIGN KEY (export_id, venue) REFERENCES public.export_runs(export_id, marketplace);

--
-- Name: idempotency_keys idempotency_keys_token_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.idempotency_keys
    ADD CONSTRAINT idempotency_keys_token_id_fkey FOREIGN KEY (token_id) REFERENCES public.api_tokens(id);

--
-- Name: ledger_entries ledger_entries_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.ledger_entries
    ADD CONSTRAINT ledger_entries_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: listing_history listing_history_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.listing_history
    ADD CONSTRAINT listing_history_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: listing_history listing_history_pricing_settings_version_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.listing_history
    ADD CONSTRAINT listing_history_pricing_settings_version_fkey FOREIGN KEY (pricing_settings_version) REFERENCES public.pricing_settings(version);

--
-- Name: offers offers_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: offers offers_listing_history_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.offers
    ADD CONSTRAINT offers_listing_history_id_fkey FOREIGN KEY (listing_history_id) REFERENCES public.listing_history(id);

--
-- Name: price_schedule price_schedule_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.price_schedule
    ADD CONSTRAINT price_schedule_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: price_schedule price_schedule_listing_history_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.price_schedule
    ADD CONSTRAINT price_schedule_listing_history_id_fkey FOREIGN KEY (listing_history_id) REFERENCES public.listing_history(id);

--
-- Name: price_schedule price_schedule_settings_version_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.price_schedule
    ADD CONSTRAINT price_schedule_settings_version_fkey FOREIGN KEY (settings_version) REFERENCES public.pricing_settings(version);

--
-- Name: pricing_evidence pricing_evidence_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.pricing_evidence
    ADD CONSTRAINT pricing_evidence_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: rdap_lookups rdap_lookups_evidence_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.rdap_lookups
    ADD CONSTRAINT rdap_lookups_evidence_id_fkey FOREIGN KEY (evidence_id) REFERENCES public.screening_evidence(id);

--
-- Name: receipts receipts_purchase_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.receipts
    ADD CONSTRAINT receipts_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES public.purchases(id);

--
-- Name: reference_files reference_files_same_as_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.reference_files
    ADD CONSTRAINT reference_files_same_as_id_fkey FOREIGN KEY (same_as_id) REFERENCES public.reference_files(id);

--
-- Name: registrar_presence registrar_presence_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.registrar_presence
    ADD CONSTRAINT registrar_presence_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: replay_runs replay_runs_settings_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.replay_runs
    ADD CONSTRAINT replay_runs_settings_id_fkey FOREIGN KEY (settings_id) REFERENCES public.selection_settings(id);

--
-- Name: replay_runs replay_runs_suite_def_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.replay_runs
    ADD CONSTRAINT replay_runs_suite_def_id_fkey FOREIGN KEY (suite_def_id) REFERENCES public.holdout_suites(id);

--
-- Name: sales sales_domain_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_domain_id_fkey FOREIGN KEY (domain_id) REFERENCES public.domains(id);

--
-- Name: sales sales_offer_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_offer_id_fkey FOREIGN KEY (offer_id) REFERENCES public.offers(id);

--
-- Name: sales sales_sale_ledger_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.sales
    ADD CONSTRAINT sales_sale_ledger_id_fkey FOREIGN KEY (sale_ledger_id) REFERENCES public.ledger_entries(id);

--
-- Name: screening_results screening_results_cached_from_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.screening_results
    ADD CONSTRAINT screening_results_cached_from_fkey FOREIGN KEY (cached_from) REFERENCES public.screening_results(id);

--
-- Name: screening_results screening_results_run_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.screening_results
    ADD CONSTRAINT screening_results_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.screening_runs(id);

--
-- Name: screening_runs screening_runs_settings_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.screening_runs
    ADD CONSTRAINT screening_runs_settings_id_fkey FOREIGN KEY (settings_id) REFERENCES public.selection_settings(id);

--
-- Name: selection_settings selection_settings_based_on_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.selection_settings
    ADD CONSTRAINT selection_settings_based_on_id_fkey FOREIGN KEY (based_on_id) REFERENCES public.selection_settings(id);

--
-- Name: tranche_members tranche_members_run_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.tranche_members
    ADD CONSTRAINT tranche_members_run_id_fkey FOREIGN KEY (run_id) REFERENCES public.screening_runs(id);

--
-- Name: tranche_members tranche_members_tranche_id_fkey; Type: FK CONSTRAINT
--

ALTER TABLE ONLY public.tranche_members
    ADD CONSTRAINT tranche_members_tranche_id_fkey FOREIGN KEY (tranche_id) REFERENCES public.tranches(id);

-- Seed data (settings singleton, pricing_settings v2, selection_settings v1, selection_lists v1 + v2 additions)
INSERT INTO public.settings DEFAULT VALUES;
SELECT public.seed_pricing_settings_v2();
SELECT public.seed_selection_v1();
SELECT public.seed_signature_lists_v2();

-- Down Migration
-- Baseline has no down migration (drop and recreate the database).
