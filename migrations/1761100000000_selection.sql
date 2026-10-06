-- Up Migration

-- Selection settings (CAP-00), versioned lists, screening evidence store (CR-001 P1a task 3).
-- Activations are columns of selection_settings (controller ruling R4), not a table: an activation is set once per version and a
-- later bring-back of an older version is a new draft, so one row never needs two activations.
CREATE TABLE selection_settings (
  id                       serial PRIMARY KEY,
  label                    text NOT NULL UNIQUE CHECK (label ~ '^[a-z0-9][a-z0-9._-]{0,31}$'),
  values                   jsonb NOT NULL,
  based_on_id              integer REFERENCES selection_settings (id),
  note                     text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  created_by               text NOT NULL,
  audit_id                 text,
  activation_seq           integer UNIQUE,
  activated_at             timestamptz,
  activation_approval_text text,
  activation_approval_at   timestamptz,
  activated_by             text,
  activation_audit_id      text,
  CHECK (
    (activation_seq IS NULL AND activated_at IS NULL AND activation_approval_text IS NULL AND activation_approval_at IS NULL AND activated_by IS NULL)
    OR (activation_seq IS NOT NULL AND activated_at IS NOT NULL AND activation_approval_text IS NOT NULL AND activation_approval_at IS NOT NULL AND activated_by IS NOT NULL)
  )
);

-- Append-only, with one exception: the activation columns can be set once, on a version that was never activated.
CREATE FUNCTION selection_settings_guard() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TRIGGER selection_settings_append_only BEFORE UPDATE OR DELETE ON selection_settings
  FOR EACH ROW EXECUTE FUNCTION selection_settings_guard();
CREATE TRIGGER selection_settings_no_truncate BEFORE TRUNCATE ON selection_settings
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE selection_lists (
  id         serial PRIMARY KEY,
  name       text NOT NULL CHECK (name ~ '^[a-z0-9_]{3,64}$'),
  version    integer NOT NULL CHECK (version >= 1),
  terms      text[] NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by text NOT NULL,
  audit_id   text,
  UNIQUE (name, version)
);
CREATE TRIGGER selection_lists_append_only BEFORE UPDATE OR DELETE ON selection_lists
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER selection_lists_no_truncate BEFORE TRUNCATE ON selection_lists
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

CREATE TABLE screening_evidence (
  id           bigserial PRIMARY KEY,
  source       text NOT NULL,
  url          text NOT NULL,
  retrieved_at timestamptz NOT NULL,
  http_status  integer,
  sha256       char(64) NOT NULL,
  content_type text,
  text_gz      bytea,
  text_bytes   integer NOT NULL,
  truncated    boolean NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER screening_evidence_append_only BEFORE UPDATE OR DELETE ON screening_evidence
  FOR EACH ROW EXECUTE FUNCTION reject_mutation();
CREATE TRIGGER screening_evidence_no_truncate BEFORE TRUNCATE ON screening_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION reject_mutation();

-- v1 = CR-001 as approved (Dvir 2026-10-06 02:05 IDT) with the CR-002 v10.1 defaults (Dvir 2026-10-06 03:24 IDT).
-- The unit test tests/unit/screening-settings.test.ts keeps the JSON below equal to DEFAULT_SELECTION_VALUES (src/screening/settings.ts).
-- No rows for the lists brand, bigco and event: Gavriel uploads them (until then the brand check is UNKNOWN / LIST_MISSING).
CREATE FUNCTION seed_selection_v1() RETURNS void LANGUAGE plpgsql AS $fn$
BEGIN
  INSERT INTO selection_settings
    (label, values, note, created_by, activation_seq, activated_at, activation_approval_text, activation_approval_at, activated_by)
  VALUES (
    'v1',
    $sel${"thresholds":{"registered_share_min":0.5,"registered_share_min_B":0.6,"form_B_max_words":2,"alt_tld_before_min":1},"form":{"geo_bands":[{"max_chars":12,"raw":10},{"max_chars":16,"raw":7},{"max_chars":20,"raw":4},{"max_chars":null,"raw":1}],"unknown_token_fails":true,"ambiguity_margin":2,"token_costs":{"typed":1,"dict3":2,"dict2":3},"short_max_words":2,"short_max_chars":12,"geo_max_words":2,"geo_max_chars":16,"geo_city_one_token":true,"formB_max_words":2,"legal_terms_list":"legal","short_token_flag_min":2,"city_word_allowlist":["akron","albany","albuquerque","amarillo","anaheim","anchorage","arlington","asheville","atlanta","austin","bakersfield","baltimore","berlin","billings","birmingham","boise","boston","brisbane","brooklyn","burbank","charleston","charlotte","chattanooga","chesapeake","cheyenne","chicago","cincinnati","cleveland","columbia","columbus","dallas","dayton","denver","detroit","dublin","durham","edmonton","eugene","evansville","fargo","fayetteville","fremont","fresno","gilbert","glendale","greensboro","hartford","henderson","hollywood","houston","huntsville","indianapolis","irvine","irving","jackson","jacksonville","knoxville","lansing","laredo","lexington","lincoln","london","louisville","lubbock","madison","malibu","manchester","manhattan","melbourne","memphis","miami","milwaukee","minneapolis","modesto","montgomery","montreal","napa","naples","nashville","newark","norfolk","oakland","olympia","omaha","ontario","orlando","ottawa","oxnard","paris","pasadena","peoria","perth","philadelphia","phoenix","pittsburgh","plano","portland","raleigh","richmond","riverside","rochester","rockford","sacramento","salem","sarasota","savannah","scottsdale","seattle","shreveport","spokane","springfield","stockton","syracuse","tacoma","tallahassee","tampa","toledo","topeka","toronto","tucson","tulsa","vancouver","washington","wichita","worcester","yonkers"]},"typo":{"max_edit_distance":1,"top_n":10000,"max_list_age_days":7},"concentration":{"max_per_attr":2,"max_lane_share":0.4,"lane_share_enforced":false},"tranche":{"size":15,"min_main_lane":10,"geo_max":3,"required_for_buy":true},"surbl":{"zone":"multi.surbl.org","control_name":"test.surbl.org","blocked_answers":["127.0.0.1"],"list_bits":{"8":"PH","16":"MW","64":"ABUSE","128":"CR"},"ns_override":[],"timeout_ms":3000},"history":{"max_fetch_per_name":6,"min_ms_between_calls":1000,"timeout_ms":20000,"retries":1,"min_content_chars":200,"strong_action":"FAIL","weak_action":"FLAG","redirect_action":"FLAG","forsale_action":"PASS","parked_action":"PASS"},"census":{"sibling_count":20,"max_unknown_share":0.25,"as_of_exact_max_days":365},"ext":{"list":["net","org","co","io","ai","info","us"]},"tier":{"order":["A","I","B","G"],"clauses":{"A":{"all":[{"f":"registered_share","op":">=","v":"$registered_share_min"},{"f":"prior_history","op":"==","v":1}]},"I":{"any":[{"tier":"A"},{"f":"alt_tld_before_n","op":">=","v":"$alt_tld_before_min"}]},"B":{"all":[{"f":"registered_share","op":">=","v":"$registered_share_min_B"},{"f":"n_words","op":"<=","v":"$form_B_max_words"}]},"G":{"all":[{"f":"is_geo","op":"==","v":1},{"f":"gform1_pass","op":"==","v":1}]}},"demand2_pass_tiers":["I","B","G"],"p_passive":{"A":0.02,"I":0.02,"B":0.01,"G":0.01}},"lead":{"gate_enabled":false,"ab_min":{"S2":8,"S3":5,"S4":5,"S6":5,"S7":5},"p_lead":{"S2":0.005,"S3":0.002,"S4":0.002,"S6":0.003,"S7":0.002}},"priors_v91":{"p_passive":{"S2":0.005,"S3":0.004,"S4":0.004,"S6":0.005,"S7":0.004}},"money":{"net_factor_afternic":0.85,"net_factor_other":0.75,"hold_years":2},"lander":{"exception_ab_min":30,"exception_retail_end_min":20},"price":{"forbidden_bands_cents":[[80000,99900],[195000,199900]],"geo_default_grade":"strong"},"score":{"weights":{"S2":{"A":15,"B":30,"C":5,"D":10,"E":10,"F":5,"G":25},"S3":{"A":15,"B":20,"C":15,"D":10,"E":25,"F":10,"G":5},"S4":{"A":15,"B":20,"C":15,"D":10,"E":25,"F":10,"G":5},"S6":{"A":15,"B":25,"C":10,"D":10,"E":20,"F":5,"G":15},"S7":{"A":10,"B":20,"C":5,"D":15,"E":10,"F":5,"G":35}},"coverage_min":0.7,"coverage_gate":false,"parked_penalty":0,"nongeo_len_bands":[{"max":8,"raw":10},{"max":12,"raw":7},{"max":16,"raw":4},{"max":null,"raw":1}],"words_bands":[{"max":1,"raw":10},{"max":2,"raw":8},{"max":3,"raw":5},{"max":null,"raw":2}],"syllable_bands":[{"max":3,"raw":10},{"max":5,"raw":7},{"max":7,"raw":4},{"max":null,"raw":1}],"d_bands":[{"min":30,"raw":9},{"min":10,"raw":6},{"min":0,"raw":2}],"retail_only_max_points":10,"risk_raw":{"clean":10,"flag":5},"forbidden_feature_keys":["govalue_usd","estibot_value","humbleworth_usd","alexa_rank","appraisal_usd"]},"namebio":{"max_cache_age_hours":48,"spot_max_per_min":4,"attribution":"Data from NameBio"},"quote":{"max_age_hours":24,"manual_max_age_days":30},"web_risk":{"safe_statuses":[1,6],"unsafe_statuses":[2,3],"requires_clean_history":true},"freshness_hours":{"availability":1,"surbl":24,"typo":24,"history":168,"census":720,"ext_dates":168,"namebio":24,"quote":24,"web_risk":168,"tm_us":168},"evidence":{"max_text_bytes":32768},"run":{"time_budget_minutes":30,"rdap_concurrency":2,"rdap_min_ms_between":250,"feature_checks":["census","ext_dates","namebio"],"gates":{"default":["form","brand_lists","typo","availability","concentration","surbl","web_risk","history","tm_us","census","ext_dates","tier","namebio","quote","price"],"S2":["form","brand_lists","typo","availability","concentration","surbl","web_risk","history","tm_us","tier","namebio","quote","price"]}},"buy_hold":true,"holdout":{"sold_accept_min":0.7,"drop_reject_min":0.75,"min_n":50,"required_suites":["BT10-1","BT10-9","BT10-11"],"report_bands":[1000,2500],"lane_report":true,"base_rates":[0.01,0.02]},"sources":{"surbl":true,"tranco":true,"namebio":false,"wayback":true,"rdap_com":true,"rdap_other":true,"iana_bootstrap":true}}$sel$::jsonb,
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
$fn$;

SELECT seed_selection_v1();

-- Down Migration

DROP FUNCTION seed_selection_v1();
DROP TABLE screening_evidence;
DROP TABLE selection_lists;
DROP TABLE selection_settings;
DROP FUNCTION selection_settings_guard();
