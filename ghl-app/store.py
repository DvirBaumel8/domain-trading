"""Data layer: one Store interface, SQLite (default) or Postgres (DATABASE_URL). Never stores Gemini output.

Retention: the newest 12 runs per location and engine are kept (a run is one engine's pass over the prompts).
Spend rows are global (no location) and are not touched by delete_location.
Tokens are encrypted at rest with a key from env GHL_TOKEN_KEY (stdlib only: HMAC-SHA256 stream + HMAC tag).
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
    raw = (os.environ.get(KEY_ENV) or "").strip()
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
]

INSTALL_FIELDS = ("company_id", "business_name", "business_website", "business_category", "business_city",
                  "trial_started_at", "status")


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

    def get_install(self, location_id, with_tokens=False):
        with self._lock:
            cur = self._exec("SELECT location_id, company_id, business_name, business_website, business_category, "
                             "business_city, access_token_enc, refresh_token_enc, installed_at, trial_started_at, status "
                             "FROM installs WHERE location_id=?", (location_id,))
            row = cur.fetchone()
        if not row:
            return None
        d = dict(zip(("location_id", "company_id", "business_name", "business_website", "business_category",
                      "business_city", "access_token", "refresh_token", "installed_at", "trial_started_at", "status"), row))
        a, r = d.pop("access_token"), d.pop("refresh_token")
        if with_tokens:
            d["access_token"], d["refresh_token"] = decrypt(a), decrypt(r)
        return d

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

    def delete_prompt(self, location_id, prompt_id):
        self._tx(lambda: self._exec("DELETE FROM prompts WHERE location_id=? AND id=?", (location_id, prompt_id)))

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
    def add_spend(self, date, engine, usd):
        self._tx(lambda: self._exec("INSERT INTO spend (date, engine, usd) VALUES (?, ?, ?)", (date, engine, float(usd))))

    def spend_total(self, month_prefix=None):
        with self._lock:
            if month_prefix:
                r = self._exec("SELECT COALESCE(SUM(usd), 0) FROM spend WHERE date LIKE ?", (month_prefix + "%",))
            else:
                r = self._exec("SELECT COALESCE(SUM(usd), 0) FROM spend")
            return float(r.fetchone()[0])

    # -- uninstall
    def delete_location(self, location_id):
        def go():
            self._exec("DELETE FROM answers WHERE run_id IN (SELECT id FROM runs WHERE location_id=?)", (location_id,))
            for t in ("runs", "prompts", "installs"):
                self._exec(f"DELETE FROM {t} WHERE location_id=?", (location_id,))
        self._tx(go)

    def count_rows(self, location_id):
        """Rows still held for a location (installs, prompts, runs, answers); 0 after delete_location."""
        with self._lock:
            n = 0
            for t in ("installs", "prompts", "runs"):
                n += self._exec(f"SELECT COUNT(*) FROM {t} WHERE location_id=?", (location_id,)).fetchone()[0]
            n += self._exec("SELECT COUNT(*) FROM answers WHERE run_id IN (SELECT id FROM runs WHERE location_id=?)",
                            (location_id,)).fetchone()[0]
            return n


def open_store(url=None):
    return Store(url)


def handle_todo(req):
    # TODO: replace with the real route (owned by another issue).
    return 501, {"error": {"code": "not_implemented", "message": "store is not built yet", "details": {}}}


def register(routes):
    """routes maps (METHOD, path) -> handler(req) -> (status, json-able dict)."""
    routes[("GET", "/store/todo")] = handle_todo
