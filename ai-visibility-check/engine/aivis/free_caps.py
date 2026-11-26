"""Monthly spend counters and hard caps for the free check (per provider).

One small record per provider per calendar month (UTC): counts and estimated USD only, plus a flag that the
cap alert went out. Never keys, prompts, answers, Suggestions, citations or names.

Spend is held in memory under a lock (race-safe across server threads) and written once per check by
`flush()` through the injected `save` callback. A crash can lose at most the checks in flight.
`try_reserve` is the only way to start a provider call: it refuses (cap_reached) when the estimated remaining
budget cannot cover the conservative cost. Nothing here bypasses for a test token.
"""
import datetime as _dt
import json
import os
import sys
import threading
import time

from . import free_config as fc


def month_key(ts: float) -> str:
    return _dt.datetime.fromtimestamp(ts, _dt.timezone.utc).strftime("%Y-%m")


class CapLedger:
    def __init__(self, caps=None, clock=None, load=None, save=None, on_cap=None):
        self.caps = dict(caps or fc.CAP_USD)
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
        """Hold `usd` for one call. False means cap_reached (and the first refusal of the month fires the alert)."""
        fire = None
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            if rec["spent_usd"] + usd <= self.caps[provider] + 1e-9:
                rec["spent_usd"] = round(rec["spent_usd"] + usd, 6)
                self._dirty.add((provider, m))
                return True
            if not rec["alerted"]:
                rec["alerted"] = True
                self._dirty.add((provider, m))
                fire = (provider, m, rec["spent_usd"], self.caps[provider])
        if fire:
            self.refused(*fire)
        return False

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

    def release(self, provider, reserved):
        """The call never reached the vendor (or was refused): give the reservation back."""
        with self._lock:
            m = self.month()
            rec = self._get(provider, m)
            rec["spent_usd"] = round(max(0.0, rec["spent_usd"] - reserved), 6)
            self._dirty.add((provider, m))

    # -- persistence -----------------------------------------------------------------------------
    def flush(self):
        """Write the changed records, once per check. Never raises."""
        with self._lock:
            todo = [(k, dict(self._rec[k])) for k in sorted(self._dirty)]
            self._dirty.clear()
        for (provider, m), rec in todo:
            if self._save:
                try:
                    self._save(provider, m, rec)
                except Exception as e:
                    print("free cap save failed: " + type(e).__name__, file=sys.stderr)


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
