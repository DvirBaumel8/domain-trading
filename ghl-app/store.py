"""Data layer: one Store interface, SQLite (default) or Postgres (DATABASE_URL). Never stores Gemini output.

Retention: the newest 12 runs per location and engine are kept (a run is one engine's pass over the prompts).
Spend rows keep the global totals after an uninstall: delete_location only unlinks their location id.
Tokens (location and company) are encrypted at rest with the key GHL_TOKEN_KEY, read through config
(stdlib only: HMAC-SHA256 stream + HMAC tag). get_store() is the one shared Store for the whole app.
"""
import base64, hashlib, hmac, json, os, sqlite3, threading
from datetime import datetime, timezone

import config

MAX_PROMPTS = 10
KEEP_RUNS = 12
MAX_EXCERPT = 300
BLOCKED_ENGINES = ("gemini",)
KEY_ENV = "GHL_TOKEN_KEY"


class StoreError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


def _now():
    return datetime.now(timezone.utc).isoformat()


# ---- token encryption -------------------------------------------------------
def _keys():
    raw = config.get()[KEY_ENV]
    if not raw:
        raise StoreError("no_encryption_key", f"{KEY_ENV} is not set; tokens cannot be stored")
    root = hashlib.sha256(raw.encode()).digest()
    return hmac.new(root, b"enc", "sha256").digest(), hmac.new(root, b"mac", "sha256").digest()


def _stream(key, nonce, n):
    out, i = b"", 0
    while len(out) < n:
        out += hmac.new(key, nonce + i.to_bytes(8, "big"), "sha256").digest()
        i += 1
    return out[:n]


def encrypt(text):
    if text is None:
        return None
    ek, mk = _keys()
    nonce = os.urandom(16)
    data = text.encode()
    ct = bytes(a ^ b for a, b in zip(data, _stream(ek, nonce, len(data))))
    tag = hmac.new(mk, nonce + ct, "sha256").digest()
    return "v1:" + base64.urlsafe_b64encode(nonce + ct + tag).decode()


def decrypt(blob):
    if blob is None:
        return None
    ek, mk = _keys()
    try:
        raw = base64.urlsafe_b64decode(blob[3:])
        nonce, ct, tag = raw[:16], raw[16:-32], raw[-32:]
    except Exception:
        raise StoreError("bad_ciphertext", "stored token is malformed")
    if not blob.startswith("v1:") or not hmac.compare_digest(tag, hmac.new(mk, nonce + ct, "sha256").digest()):
        raise StoreError("bad_ciphertext", "stored token failed authentication (wrong key?)")
    return bytes(a ^ b for a, b in zip(ct, _stream(ek, nonce, len(ct)))).decode()


# ---- schema -----------------------------------------------------------------
# {ID} becomes an autoincrement primary key per backend.
MIGRATIONS = [
    (1, [
        """CREATE TABLE installs (
            location_id TEXT PRIMARY KEY, company_id TEXT, business_name TEXT, business_website TEXT,
            business_category TEXT, business_city TEXT,
            access_token_enc TEXT, refresh_token_enc TEXT,
            installed_at TEXT NOT NULL, trial_started_at TEXT, status TEXT NOT NULL DEFAULT 'active')""",
        """CREATE TABLE prompts (
            id {ID}, location_id TEXT NOT NULL, text TEXT NOT NULL)""",
        "CREATE INDEX prompts_loc ON prompts(location_id)",
        """CREATE TABLE runs (
            id {ID}, location_id TEXT NOT NULL, started_at TEXT NOT NULL, engine TEXT NOT NULL,
            status TEXT NOT NULL, cost_usd DOUBLE PRECISION NOT NULL DEFAULT 0)""",
        "CREATE INDEX runs_loc ON runs(location_id, engine, started_at)",
        """CREATE TABLE answers (
            run_id BIGINT NOT NULL, prompt_id BIGINT NOT NULL, engine TEXT NOT NULL,
            mentioned BOOLEAN NOT NULL, position INTEGER, competitors TEXT NOT NULL,
            excerpt TEXT NOT NULL, sources TEXT NOT NULL)""",
        "CREATE INDEX answers_run ON answers(run_id)",
        """CREATE TABLE spend (
            date TEXT NOT NULL, engine TEXT NOT NULL, usd DOUBLE PRECISION NOT NULL)""",
    ]),
    (2, [
        "ALTER TABLE installs ADD COLUMN expires_at BIGINT",
        "ALTER TABLE installs ADD COLUMN user_type TEXT",
        "ALTER TABLE installs ADD COLUMN scopes TEXT",
        "ALTER TABLE installs ADD COLUMN plan TEXT NOT NULL DEFAULT 'trial'",
        """CREATE TABLE company_tokens (
            company_id TEXT PRIMARY KEY, access_token_enc TEXT, refresh_token_enc TEXT, expires_at BIGINT)""",
        """CREATE TABLE run_claims (
            location_id TEXT NOT NULL, run_key TEXT NOT NULL, claimed_at TEXT NOT NULL,
            PRIMARY KEY (location_id, run_key))""",
        "ALTER TABLE spend ADD COLUMN location_id TEXT",
        "CREATE INDEX spend_date ON spend(date)",
    ]),
]

INSTALL_FIELDS = ("company_id", "business_name", "business_website", "business_category", "business_city",
                  "trial_started_at", "status", "expires_at", "user_type", "scopes", "plan")
_INSTALL_COLS = ("location_id", "company_id", "business_name", "business_website", "business_category",
                 "business_city", "access_token_enc", "refresh_token_enc", "installed_at", "trial_started_at",
                 "status", "expires_at", "user_type", "scopes", "plan")


class Store:
    def __init__(self, url=None):
        url = url or config.get()["DATABASE_URL"]
        self.pg = url.startswith(("postgres://", "postgresql://"))
        self._lock = threading.RLock()
        if self.pg:
            import psycopg  # only needed for Postgres
            self.conn = psycopg.connect(url)
        else:
            path = url[len("sqlite:///"):] if url.startswith("sqlite:///") else url
            self.conn = sqlite3.connect(path or ":memory:", check_same_thread=False)
        self._migrate()

    # -- plumbing
    def _sql(self, q):
        return q.replace("?", "%s") if self.pg else q

    def _exec(self, q, args=()):
        cur = self.conn.cursor()
        cur.execute(self._sql(q), args)
        return cur

    def _tx(self, fn):
        with self._lock:
            try:
                out = fn()
                self.conn.commit()
                return out
            except BaseException:
                self.conn.rollback()
                raise

    def _migrate(self):
        ident = "BIGSERIAL PRIMARY KEY" if self.pg else "INTEGER PRIMARY KEY AUTOINCREMENT"

        def go():
            self._exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)")
            done = {r[0] for r in self._exec("SELECT version FROM schema_migrations").fetchall()}
            for version, stmts in MIGRATIONS:
                if version in done:
                    continue
                for s in stmts:
                    self._exec(s.replace("{ID}", ident))
                self._exec("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (version, _now()))
        self._tx(go)

    def close(self):
        self.conn.close()

    def schema_version(self):
        with self._lock:
            return self._exec("SELECT MAX(version) FROM schema_migrations").fetchone()[0]

    # -- installs
    def upsert_install(self, location_id, access_token=None, refresh_token=None, **fields):
        bad = set(fields) - set(INSTALL_FIELDS)
        if bad:
            raise StoreError("bad_field", f"unknown install fields: {sorted(bad)}")
        at, rt = encrypt(access_token), encrypt(refresh_token)  # before any write: fails closed without a key

        def go():
            exists = self._exec("SELECT 1 FROM installs WHERE location_id=?", (location_id,)).fetchone()
            if not exists:
                self._exec("INSERT INTO installs (location_id, installed_at) VALUES (?, ?)", (location_id, _now()))
            sets = dict(fields)
            if access_token is not None:
                sets["access_token_enc"] = at
            if refresh_token is not None:
                sets["refresh_token_enc"] = rt
            if sets:
                cols = ", ".join(f"{k}=?" for k in sets)
                self._exec(f"UPDATE installs SET {cols} WHERE location_id=?", (*sets.values(), location_id))
        self._tx(go)

    def save_install(self, location_id, company_id, access_token, refresh_token, expires_at, user_type, scopes):
        """Create or update an install with its (encrypted) tokens; expires_at is epoch seconds."""
        self.upsert_install(location_id, access_token, refresh_token, company_id=company_id,
                            expires_at=int(expires_at) if expires_at is not None else None,
                            user_type=user_type, scopes=scopes, status="active")

    def get_install(self, location_id, with_tokens=False):
        with self._lock:
            cur = self._exec(f"SELECT {', '.join(_INSTALL_COLS)} FROM installs WHERE location_id=?", (location_id,))
            row = cur.fetchone()
        if not row:
            return None
        d = dict(zip(_INSTALL_COLS, row))
        a, r = d.pop("access_token_enc"), d.pop("refresh_token_enc")
        if with_tokens:
            d["access_token"], d["refresh_token"] = decrypt(a), decrypt(r)
        return d

    def update_location(self, location_id, name=None, website=None, city=None, category=None):
        """Update business fields of an installed location; None leaves a field as is. False if not installed."""
        sets = {k: v for k, v in (("business_name", name), ("business_website", website), ("business_city", city),
                                  ("business_category", category)) if v is not None}

        def go():
            if not self._exec("SELECT 1 FROM installs WHERE location_id=?", (location_id,)).fetchone():
                return False
            if sets:
                cols = ", ".join(f"{k}=?" for k in sets)
                self._exec(f"UPDATE installs SET {cols} WHERE location_id=?", (*sets.values(), location_id))
            return True
        return self._tx(go)

    @staticmethod
    def _loc(d):
        """Install row -> the location dict the run engine uses."""
        return {"id": d["location_id"], "agency_id": d["company_id"], "name": d["business_name"] or "",
                "website": d["business_website"] or "", "category": d["business_category"] or "",
                "city": d["business_city"] or "", "plan": d["plan"] or "trial", "installed_at": d["installed_at"],
                "active": d["status"] == "active"}

    def get_location(self, location_id):
        d = self.get_install(location_id)
        return self._loc(d) if d else None

    def list_locations(self):
        with self._lock:
            rows = self._exec(f"SELECT {', '.join(_INSTALL_COLS)} FROM installs ORDER BY installed_at, location_id").fetchall()
        return [self._loc(dict(zip(_INSTALL_COLS, r))) for r in rows]

    # -- company (agency) tokens
    def save_company_token(self, company_id, access_token, refresh_token, expires_at):
        at, rt = encrypt(access_token), encrypt(refresh_token)

        def go():
            self._exec("DELETE FROM company_tokens WHERE company_id=?", (company_id,))
            self._exec("INSERT INTO company_tokens (company_id, access_token_enc, refresh_token_enc, expires_at) "
                       "VALUES (?, ?, ?, ?)", (company_id, at, rt, int(expires_at) if expires_at is not None else None))
        self._tx(go)

    def get_company_token(self, company_id):
        with self._lock:
            row = self._exec("SELECT access_token_enc, refresh_token_enc, expires_at FROM company_tokens "
                             "WHERE company_id=?", (company_id,)).fetchone()
        if not row:
            return None
        return {"company_id": company_id, "access_token": decrypt(row[0]), "refresh_token": decrypt(row[1]),
                "expires_at": row[2]}

    # -- prompts
    def add_prompt(self, location_id, text):
        text = (text or "").strip()
        if not text:
            raise StoreError("empty_prompt", "prompt text is empty")

        def go():
            n = self._exec("SELECT COUNT(*) FROM prompts WHERE location_id=?", (location_id,)).fetchone()[0]
            if n >= MAX_PROMPTS:
                raise StoreError("prompt_cap", f"at most {MAX_PROMPTS} prompts per location")
            return self._exec("INSERT INTO prompts (location_id, text) VALUES (?, ?) RETURNING id",
                              (location_id, text)).fetchone()[0]
        return self._tx(go)

    def list_prompts(self, location_id):
        with self._lock:
            rows = self._exec("SELECT id, text FROM prompts WHERE location_id=? ORDER BY id", (location_id,)).fetchall()
        return [{"id": i, "text": t} for i, t in rows]

    def replace_prompts(self, location_id, texts):
        """Replace all prompts of a location in one transaction (empty list = back to the defaults)."""
        texts = [(t or "").strip() for t in texts]
        texts = [t for t in texts if t]
        if len(texts) > MAX_PROMPTS:
            raise StoreError("prompt_cap", f"at most {MAX_PROMPTS} prompts per location")

        def go():
            self._exec("DELETE FROM prompts WHERE location_id=?", (location_id,))
            for t in texts:
                self._exec("INSERT INTO prompts (location_id, text) VALUES (?, ?)", (location_id, t))
        self._tx(go)
        return self.list_prompts(location_id)

    def delete_prompt(self, location_id, prompt_id):
        self._tx(lambda: self._exec("DELETE FROM prompts WHERE location_id=? AND id=?", (location_id, prompt_id)))

    # -- run claims (atomic: one (location, run key) is claimed once, ever)
    def claim_run(self, location_id, run_key):
        """True if this call claimed the key; False if it was already claimed."""
        def go():
            cur = self._exec("INSERT INTO run_claims (location_id, run_key, claimed_at) VALUES (?, ?, ?) "
                             "ON CONFLICT (location_id, run_key) DO NOTHING", (location_id, run_key, _now()))
            return cur.rowcount == 1
        return self._tx(go)

    def has_run(self, location_id, run_key):
        with self._lock:
            return bool(self._exec("SELECT 1 FROM run_claims WHERE location_id=? AND run_key=?",
                                   (location_id, run_key)).fetchone())

    # -- runs and answers
    @staticmethod
    def _check_engine(engine):
        if (engine or "").strip().lower() in BLOCKED_ENGINES:
            raise StoreError("engine_blocked", f"{engine} output is never stored")

    def add_run(self, location_id, engine, status="done", cost_usd=0.0, started_at=None, answers=()):
        """Insert a run with its answers (dicts: prompt_id, mentioned, position, competitors, excerpt, sources), then prune."""
        self._check_engine(engine)
        for a in answers:
            self._check_engine(a.get("engine", engine))

        def go():
            run_id = self._exec("INSERT INTO runs (location_id, started_at, engine, status, cost_usd) "
                                "VALUES (?, ?, ?, ?, ?) RETURNING id",
                                (location_id, started_at or _now(), engine, status, float(cost_usd))).fetchone()[0]
            for a in answers:
                self._exec("INSERT INTO answers (run_id, prompt_id, engine, mentioned, position, competitors, excerpt, sources) "
                           "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                           (run_id, a["prompt_id"], engine, bool(a["mentioned"]), a.get("position"),
                            json.dumps(list(a.get("competitors") or [])), (a.get("excerpt") or "")[:MAX_EXCERPT],
                            json.dumps(list(a.get("sources") or []))))
            self._prune(location_id, engine)
            return run_id
        return self._tx(go)

    def _prune(self, location_id, engine):
        old = self._exec("SELECT id FROM runs WHERE location_id=? AND engine=? ORDER BY started_at DESC, id DESC",
                         (location_id, engine)).fetchall()[KEEP_RUNS:]
        for (rid,) in old:
            self._exec("DELETE FROM answers WHERE run_id=?", (rid,))
            self._exec("DELETE FROM runs WHERE id=?", (rid,))

    def _answers(self, run_id):
        rows = self._exec("SELECT prompt_id, mentioned, position, competitors, excerpt, sources FROM answers "
                          "WHERE run_id=? ORDER BY prompt_id", (run_id,)).fetchall()
        return [{"prompt_id": p, "mentioned": bool(m), "position": pos, "competitors": json.loads(c),
                 "excerpt": e, "sources": json.loads(s)} for p, m, pos, c, e, s in rows]

    def history(self, location_id, n):
        """{engine: [run, ...]} with the last n runs per engine, newest first, each with its answers."""
        out = {}
        with self._lock:
            engines = [r[0] for r in self._exec("SELECT DISTINCT engine FROM runs WHERE location_id=? ORDER BY engine",
                                                (location_id,)).fetchall()]
            for eng in engines:
                rows = self._exec("SELECT id, started_at, status, cost_usd FROM runs WHERE location_id=? AND engine=? "
                                  "ORDER BY started_at DESC, id DESC LIMIT ?", (location_id, eng, int(n))).fetchall()
                out[eng] = [{"run_id": i, "started_at": s, "engine": eng, "status": st, "cost_usd": c,
                             "answers": self._answers(i)} for i, s, st, c in rows]
        return out

    def trend(self, location_id):
        """Mention rate per run, oldest first: [{run_id, started_at, engine, rate, answered}]. Runs with no answers are skipped."""
        with self._lock:
            rows = self._exec(
                "SELECT r.id, r.started_at, r.engine, COUNT(a.run_id), "
                "COALESCE(SUM(CASE WHEN a.mentioned THEN 1 ELSE 0 END), 0) "
                "FROM runs r JOIN answers a ON a.run_id = r.id WHERE r.location_id=? "
                "GROUP BY r.id, r.started_at, r.engine ORDER BY r.started_at, r.id", (location_id,)).fetchall()
        return [{"run_id": i, "started_at": s, "engine": e, "rate": round(m / t, 4), "answered": t}
                for i, s, e, t, m in rows]

    # -- spend
    def add_spend(self, date, engine, usd, location_id=None):
        self._tx(lambda: self._exec("INSERT INTO spend (date, engine, usd, location_id) VALUES (?, ?, ?, ?)",
                                    (date, engine, float(usd), location_id)))

    def spend_total(self, month_prefix=None, location_id=None):
        q, args, where = "SELECT COALESCE(SUM(usd), 0) FROM spend", [], []
        if month_prefix:
            where.append("date LIKE ?")
            args.append(month_prefix + "%")
        if location_id:
            where.append("location_id=?")
            args.append(location_id)
        with self._lock:
            r = self._exec(q + (" WHERE " + " AND ".join(where) if where else ""), tuple(args))
            return float(r.fetchone()[0])

    # -- uninstall
    def delete_location(self, location_id):
        def go():
            self._exec("DELETE FROM answers WHERE run_id IN (SELECT id FROM runs WHERE location_id=?)", (location_id,))
            for t in ("runs", "prompts", "run_claims", "installs"):
                self._exec(f"DELETE FROM {t} WHERE location_id=?", (location_id,))
            self._exec("UPDATE spend SET location_id=NULL WHERE location_id=?", (location_id,))
        self._tx(go)

    def count_rows(self, location_id):
        """Rows still held for a location (installs, prompts, runs, answers); 0 after delete_location."""
        with self._lock:
            n = 0
            for t in ("installs", "prompts", "runs", "run_claims"):
                n += self._exec(f"SELECT COUNT(*) FROM {t} WHERE location_id=?", (location_id,)).fetchone()[0]
            n += self._exec("SELECT COUNT(*) FROM answers WHERE run_id IN (SELECT id FROM runs WHERE location_id=?)",
                            (location_id,)).fetchone()[0]
            return n


def open_store(url=None):
    return Store(url)


_shared = None
_shared_lock = threading.Lock()


def get_store():
    """The one shared Store, created lazily from DATABASE_URL."""
    global _shared
    with _shared_lock:
        if _shared is None:
            _shared = Store(config.get()["DATABASE_URL"])
        return _shared


def set_store(store=None):
    """Replace the shared Store (tests); None resets it so the next get_store() opens a new one."""
    global _shared
    with _shared_lock:
        _shared = store


def handle_todo(req):
    # TODO: replace with the real route (owned by another issue).
    return 501, {"error": {"code": "not_implemented", "message": "store is not built yet", "details": {}}}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/store/todo")] = handle_todo
