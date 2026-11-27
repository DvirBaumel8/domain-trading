"""Monthly spend counters and hard caps for the free check (per provider).

One small record per provider per calendar month (UTC): counts and estimated USD only, plus a flag that the
cap alert went out. Never keys, prompts, answers, Suggestions, citations or names.

Spend is held in memory under a lock (race-safe across server threads) and written once per check by
`flush()` through the injected `save` callback. A crash can lose at most the checks in flight.
`try_reserve` is the only way to start a provider call: it refuses (cap_reached) when the estimated remaining
budget cannot cover the conservative cost. Nothing here bypasses for a test token.

Daily limits (UTC calendar day, same clock as the monthly counters) sit on top of the monthly caps: a per-provider
USD slice (monthly cap / days in the month, or AVC_FREE_DAILY_CAP_USD as a global ceiling over both providers) and a
maximum number of free-run checks (AVC_FREE_DAILY_MAX_CHECKS). One small record per day: check count, estimated USD
per provider and an alert flag. Never keys, prompts, answers, Suggestions, citations or names.
"""
import calendar
import datetime as _dt
import json
import os
import sys
import threading
import time

from . import free_config as fc


def month_key(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime("%Y-%m")


def day_key(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime("%Y-%m-%d")


def days_in_month(ts: float) -> int:
    d = _dt.datetime.fromtimestamp(ts, _dt.timezone.utc)
    return calendar.monthrange(d.year, d.month)[1]


class CapLedger:
    def __init__(self, caps=None, clock=None, load=None, save=None, on_cap=None,
                 load_day=None, save_day=None, on_daily=None, daily_caps=None, daily_global=None, daily_max=None):
        self.caps = dict(caps or fc.CAP_USD)
        self._load_day, self._save_day, self._on_daily = load_day, save_day, on_daily
        self._daily_caps, self._daily_global, self._daily_max = daily_caps, daily_global, daily_max
        self._days = {}         # day -> record
        self._dirty_days = set()
        self._clock = clock or time.time
        self._load, self._save, self._on_cap = load, save, on_cap
        self._lock = threading.RLock()
        self._rec = {}          # (provider, month) -> record
        self._dirty = set()

    # -- records ---------------------------------------------------------------------------------
    def month(self) -> str:
        return month_key(self._clock())

    def _get(self, provider, month):
        key = (provider, month)
        if key not in self._rec:
            rec = None
            if self._load:
                try:
                    rec = self._load(provider, month)
                except Exception as e:      # an unreadable counter must never stop the check or leak anything
                    print("free cap load failed: " + type(e).__name__, file=sys.stderr)
            base = {"provider": provider, "month": month, "calls": 0, "searches": 0,
                    "input_tokens": 0, "output_tokens": 0, "spent_usd": 0.0, "alerted": False}
            if isinstance(rec, dict):
                for k in base:
                    if k in rec and type(rec[k]) in (type(base[k]), int, float):
                        base[k] = rec[k]
            self._rec[key] = base
        return self._rec[key]

    def spent(self, provider) -> float:
        with self._lock:
            return float(self._get(provider, self.month())["spent_usd"])

    def remaining(self, provider) -> float:
        return self.caps[provider] - self.spent(provider)

    # -- spending --------------------------------------------------------------------------------
    def can_afford(self, provider, usd) -> bool:
        return self.remaining(provider) + 1e-9 >= usd

    def try_reserve(self, provider, usd) -> bool:
        """Hold `usd` for one call. False means a cap refused it (see reserve_reason)."""
        return self.reserve_reason(provider, usd) is None

    def reserve_reason(self, provider, usd):
        """Hold `usd` for one call. None = held; else 'cap_reached' (monthly; the first refusal of the month
        fires the alert) or 'daily_cap_reached'."""
        fire = None
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            if rec["spent_usd"] + usd <= self.caps[provider] + 1e-9:
                if not self._daily_room(provider, usd):
                    self._daily_refused(provider)
                    return "daily_cap_reached"
                rec["spent_usd"] = round(rec["spent_usd"] + usd, 6)
                self._dirty.add((provider, m))
                self._daily_add(provider, usd)
                return None
            if not rec["alerted"]:
                rec["alerted"] = True
                self._dirty.add((provider, m))
                fire = (provider, m, rec["spent_usd"], self.caps[provider])
        if fire:
            self.refused(*fire)
        return "cap_reached"

    def refuse_check(self, provider) -> None:
        """A whole check was refused up front for this provider; first time in a month it alerts."""
        fire = None
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            if not rec["alerted"]:
                rec["alerted"] = True
                self._dirty.add((provider, m))
                fire = (provider, m, rec["spent_usd"], self.caps[provider])
        if fire:
            self.refused(*fire)

    def refused(self, provider, month, spent, cap):
        print(f"free_cap provider={provider} reason=cap_reached spent_usd={spent:.4f} cap_usd={cap:.2f} month={month}",
              file=sys.stderr)
        if self._on_cap:
            try:
                self._on_cap(provider, month, spent, cap)
            except Exception as e:
                print("free cap alert failed: " + type(e).__name__, file=sys.stderr)

    def settle(self, provider, reserved, actual, calls=1, searches=0, input_tokens=0, output_tokens=0):
        """Replace the reservation with the estimated real cost (actual=None keeps the reservation)."""
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            if actual is not None:
                rec["spent_usd"] = round(max(0.0, rec["spent_usd"] - reserved + actual), 6)
            rec["calls"] += calls
            rec["searches"] += searches
            rec["input_tokens"] += input_tokens
            rec["output_tokens"] += output_tokens
            self._dirty.add((provider, m))
            if actual is not None:
                self._daily_add(provider, actual - reserved)

    def release(self, provider, reserved):
        """The call never reached the vendor (or was refused): give the reservation back."""
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            rec["spent_usd"] = round(max(0.0, rec["spent_usd"] - reserved), 6)
            self._dirty.add((provider, m))
            self._daily_add(provider, -reserved)

    # -- daily limits ----------------------------------------------------------------------------
    def day(self) -> str:
        return day_key(self._clock())

    def _day_rec(self):
        d = self.day()
        if d not in self._days:
            rec = None
            if self._load_day:
                try:
                    rec = self._load_day(d)
                except Exception as e:
                    print("free daily load failed: " + type(e).__name__, file=sys.stderr)
            base = {"day": d, "checks": 0, "spent_usd": {p: 0.0 for p in self.caps}, "alerted": False}
            if isinstance(rec, dict):
                if type(rec.get("checks")) is int and rec["checks"] >= 0:
                    base["checks"] = rec["checks"]
                if isinstance(rec.get("spent_usd"), dict):
                    for p in base["spent_usd"]:
                        v = rec["spent_usd"].get(p)
                        if isinstance(v, (int, float)) and not isinstance(v, bool) and v >= 0:
                            base["spent_usd"][p] = float(v)
                base["alerted"] = bool(rec.get("alerted"))
            self._days[d] = base
        return self._days[d]

    def daily_cap(self, provider) -> float:
        if self._daily_caps is not None:
            return self._daily_caps[provider]
        return self.caps[provider] / days_in_month(self._clock())

    def daily_global(self):
        return self._daily_global if self._daily_global is not None else fc.daily_global_cap_usd()

    def daily_max(self) -> int:
        return self._daily_max if self._daily_max is not None else fc.daily_max_checks()

    def _daily_room(self, provider, usd) -> bool:
        rec = self._day_rec()
        spent = rec["spent_usd"]
        if spent.get(provider, 0.0) + usd > self.daily_cap(provider) + 1e-9:
            return False
        g = self.daily_global()
        return g is None or sum(spent.values()) + usd <= g + 1e-9

    def _daily_add(self, provider, usd):
        rec = self._day_rec()
        rec["spent_usd"][provider] = round(max(0.0, rec["spent_usd"].get(provider, 0.0) + usd), 6)
        self._dirty_days.add(rec["day"])

    def daily_room(self, provider, usd) -> bool:
        """Peek: would one call of `usd` fit in today's USD limits?"""
        with self._lock:
            return self._daily_room(provider, usd)

    def daily_checks_full(self) -> bool:
        """Peek: today's check slots are used up."""
        with self._lock:
            return self._day_rec()["checks"] >= self.daily_max()

    def claim_check(self) -> bool:
        """Take one of today's free-run slots. False = the daily limit is reached (logged)."""
        with self._lock:
            rec = self._day_rec()
            if rec["checks"] >= self.daily_max():
                refused = True
            else:
                refused = False
                rec["checks"] += 1
                self._dirty_days.add(rec["day"])
        if refused:
            self.daily_refused("max_checks")
        return not refused

    def release_check(self):
        """The check never reached a vendor: give its slot back."""
        with self._lock:
            rec = self._day_rec()
            rec["checks"] = max(0, rec["checks"] - 1)
            self._dirty_days.add(rec["day"])

    def _daily_refused(self, what):
        self.daily_refused(what)

    def daily_refused(self, what):
        """Structured log line (and the once-a-day alert hook) when a daily limit refuses a check."""
        with self._lock:
            rec = self._day_rec()
            first = not rec["alerted"]
            rec["alerted"] = True
            self._dirty_days.add(rec["day"])
            day, checks = rec["day"], rec["checks"]
            spent = round(sum(rec["spent_usd"].values()), 4)
        print(f"free_cap reason=daily_cap_reached limit={what} checks={checks} spent_usd={spent:.4f} day={day}",
              file=sys.stderr)
        if first and self._on_daily:
            try:
                self._on_daily(day, checks, spent)
            except Exception as e:
                print("free daily alert failed: " + type(e).__name__, file=sys.stderr)

    # -- persistence -----------------------------------------------------------------------------
    def flush(self):
        """Write the changed records, once per check. Never raises."""
        with self._lock:
            todo = [(k, dict(self._rec[k])) for k in sorted(self._dirty)]
            self._dirty.clear()
            days = [(d, json.loads(json.dumps(self._days[d]))) for d in sorted(self._dirty_days)]
            self._dirty_days.clear()
        for (provider, m), rec in todo:
            if self._save:
                try:
                    self._save(provider, m, rec)
                except Exception as e:
                    print("free cap save failed: " + type(e).__name__, file=sys.stderr)
        for d, rec in days:
            if self._save_day:
                try:
                    self._save_day(d, rec)
                except Exception as e:
                    print("free daily save failed: " + type(e).__name__, file=sys.stderr)


class LocalFileStore:
    """Default persistence for the CLI and tests: one JSON file per provider and month."""
    def __init__(self, folder):
        self.folder = folder

    def _path(self, provider, month):
        return os.path.join(self.folder, f"{provider}-{month}.json")

    def load(self, provider, month):
        try:
            with open(self._path(provider, month), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def load_day(self, day):
        try:
            with open(os.path.join(self.folder, f"daily-{day}.json"), encoding="utf-8") as f:
                return json.load(f)
        except (OSError, ValueError):
            return None

    def save_day(self, day, rec):
        os.makedirs(self.folder, exist_ok=True)
        path = os.path.join(self.folder, f"daily-{day}.json")
        with open(path + ".tmp", "w", encoding="utf-8") as f:
            json.dump(rec, f)
        os.replace(path + ".tmp", path)

    def save(self, provider, month, rec):
        os.makedirs(self.folder, exist_ok=True)
        tmp = self._path(provider, month) + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(rec, f)
        os.replace(tmp, self._path(provider, month))


# The process-wide ledger. The server installs persistence and the alert hook at start-up; tests replace it.
LEDGER = CapLedger()


def install(ledger):
    global LEDGER
    LEDGER = ledger
    return ledger
