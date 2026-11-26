"""The run loop without the Apify SDK: `push(row, charge)` decides what is charged. No key, header or provider text is kept."""
from __future__ import annotations

import asyncio
import logging
import re
import time
from collections import Counter
from dataclasses import dataclass
from datetime import datetime, timezone
from decimal import Decimal

from . import config, extract, matching, prompts, summary
from .providers import Providers, ProviderError

log = logging.getLogger("ai-brand-mention-check")
HOST = re.compile(r"(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}")
ERROR_TEXT = {
    "timeout": "timed out after 60 seconds, twice",
    "rate_limited": "rate-limited by the provider (not a quota problem)",
    "quota_exhausted": "the provider says the quota or credit is used up",
    "provider_error": "the provider returned an error",
    "engine_not_configured": "the engine is switched off or has no key on this server",
    "budget_cap": "the spend guard for this run was reached",
    "charge_limit": "your maximum charge for the run was reached",
}


@dataclass
class Pricing:
    """Read from the charging manager at run time. Nothing here is a fixed price."""
    result_usd: Decimal | None = None
    start_usd: Decimal = Decimal(0)
    max_total_usd: Decimal | None = None


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def normalise_domain(raw: str) -> str:
    d = raw.strip().lower()
    d = re.sub(r"^[a-z][a-z0-9+.\-]*://", "", d)
    d = re.split(r"[/?#]", d, maxsplit=1)[0].rsplit("@", 1)[-1]
    d = re.sub(r":\d+$", "", d).strip(".")
    return d[4:] if d.startswith("www.") else d


def _text_list(inp: dict, key: str, label: str, max_items: int, lo: int, hi: int) -> tuple[list[str], str | None]:
    raw = inp.get(key)
    if raw in (None, ""):
        return [], None
    if not isinstance(raw, list) or not all(isinstance(x, str) for x in raw):
        return [], f"{label}: give a list of text lines."
    items = [x.strip() for x in raw if x.strip()]
    if len(items) > max_items:
        return [], f"{label}: at most {max_items} entries (you gave {len(items)})."
    for x in items:
        if not lo <= len(x) <= hi:
            return [], f"{label}: each entry needs {lo} to {hi} characters (one has {len(x)})."
    return items, None


def validate_input(inp: dict) -> tuple[dict | None, str | None]:
    """(settings, None) or (None, plain message naming the field). Runs before any API call."""
    inp = inp or {}

    def text(key: str) -> str:
        v = inp.get(key)
        return v.strip() if isinstance(v, str) else ""

    brand = text("brand")
    if not 2 <= len(brand) <= 80:
        return None, f"brand: needs 2 to 80 characters (you gave {len(brand)})."
    domain = None
    if text("domain"):
        domain = normalise_domain(text("domain"))
        if not HOST.fullmatch(domain):
            return None, "domain: use a website address such as asana.com (a hostname with a dot)."
    aliases, err = _text_list(inp, "aliases", "aliases", 5, 2, 80)
    if err:
        return None, err
    custom, err = _text_list(inp, "prompts", "prompts", 20, 8, 300)
    if err:
        return None, err
    category = text("category")
    if category and not 3 <= len(category) <= 80:
        return None, f"category: needs 3 to 80 characters (you gave {len(category)})."
    if not category and not custom:
        return None, "category: add a category (for example project management software) or your own questions in prompts."
    location = text("location")
    if len(location) > 80:
        return None, "location: at most 80 characters."
    count = inp.get("promptCount", 3)
    if count is None:
        count = 3
    if isinstance(count, float) and count.is_integer():
        count = int(count)
    if not isinstance(count, int) or isinstance(count, bool) or not 1 <= count <= 8:
        return None, "promptCount: a whole number from 1 to 8."
    engines = inp.get("engines")
    engines = list(config.ENGINES) if engines is None else engines
    if not isinstance(engines, list) or not engines:
        return None, "engines: choose at least one of chatgpt, gemini, claude."
    if any(e not in config.ENGINES for e in engines):
        return None, "engines: only chatgpt, gemini and claude are supported."
    include = inp.get("includeAnswerText", True)
    if not isinstance(include, bool):
        return None, "includeAnswerText: true or false."
    questions = custom or prompts.generate_prompts(category, count, location)
    return {"brand": brand, "domain": domain, "aliases": aliases, "category": category or None, "location": location,
            "prompts": questions, "engines": list(dict.fromkeys(engines)), "include_answer": include}, None


def blank_row(cfg: dict, engine: str, index: int, prompt: str, code: str | None, checked_at: str) -> dict:
    return {
        "brand": cfg["brand"], "domain": cfg["domain"], "category": cfg["category"], "promptIndex": index, "prompt": prompt,
        "engine": engine, "model": config.model_for(engine), "status": "error" if code else "ok", "errorCode": code,
        "mentioned": None, "mentionType": None, "rank": None, "listLength": None, "snippet": None, "competitors": [],
        "brandCited": None, "citedUrls": [], "searchUsed": None, "sentiment": None, "extraction": None, "answerText": None,
        "latencyMs": None, "checkedAt": checked_at,
    }


class Spend:
    """The run spend guard: reserve an estimate before a call, refund it when the call fails."""

    def __init__(self, limit: Decimal):
        self.limit, self.used = limit, Decimal(0)

    def reserve(self, amount: Decimal) -> bool:
        if self.used + amount > self.limit:
            return False
        self.used += amount
        return True

    def refund(self, amount: Decimal) -> None:
        self.used = max(Decimal(0), self.used - amount)


def _fmt(x: Decimal) -> str:
    return f"{x:.4f}".rstrip("0").rstrip(".") if x != x.to_integral() else str(int(x))


async def run(inp: dict, *, client, push, set_status, set_summary, pricing: Pricing | None = None,
              sleep=asyncio.sleep, clock=time.monotonic, now=utc_now) -> tuple[bool, str]:
    for noisy in ("httpx", "httpcore"):
        logging.getLogger(noisy).setLevel(logging.WARNING)
    cfg, problem = validate_input(inp)
    if problem:
        return False, problem
    pricing = pricing or Pricing()
    max_total = pricing.max_total_usd if pricing.max_total_usd is not None else config.max_total_charge_usd()
    jobs = [(i, p, e) for i, p in enumerate(cfg["prompts"], 1) for e in cfg["engines"]]
    notes = ""
    cap = config.max_rows()
    if len(jobs) > cap:
        who = "On the free plan" if not config.is_paying() else "Per run"
        notes = f" {who} a run covers at most {cap} rows (question x engine); {len(jobs) - cap} of {len(jobs)} rows were not run."
        jobs = jobs[:cap]
    if pricing.result_usd is not None and max_total is not None:
        need = len(jobs) * pricing.result_usd + pricing.start_usd
        if need > max_total:
            return False, (f"This run can cost up to {_fmt(need)} USD ({len(jobs)} rows x {_fmt(pricing.result_usd)} per result "
                           f"+ {_fmt(pricing.start_usd)} start), more than your maximum charge of {_fmt(max_total)} USD. "
                           "Raise the maximum charge or ask fewer questions or engines.")
    names = matching.build_names(cfg["brand"], cfg["aliases"])
    providers = Providers(client, sleep)
    spend = Spend(config.max_provider_cost())
    sems = {e: asyncio.Semaphore(config.ENGINE_CONCURRENCY) for e in cfg["engines"]}
    off = config.disabled_engines()
    state = {"stop": False}
    dead: dict[str, str] = {}
    rows: list[dict] = []
    started = clock()
    await set_status(f"Asking {len(cfg['engines'])} engines {len(cfg['prompts'])} questions ({len(jobs)} answers).")

    async def answer(i: int, prompt: str, engine: str) -> dict:
        def fail(code: str) -> dict:
            return blank_row(cfg, engine, i, prompt, code, now())
        if engine in off or not config.engine_key(engine):
            return fail("engine_not_configured")
        async with sems[engine]:
            if state["stop"]:
                return fail("charge_limit")
            if clock() - started > config.RUN_LIMIT_SECS:
                return fail("timeout")
            if engine in dead:
                return fail(dead[engine])
            cost, extra = config.COST_ESTIMATE[engine], config.COST_ESTIMATE["extractor"]
            if not spend.reserve(cost + extra):
                return fail("budget_cap")
            t0 = clock()
            try:
                ans = await providers.ask(engine, prompt, cfg["location"])
            except ProviderError as e:
                spend.refund(cost + extra)
                if e.code == "quota_exhausted":
                    dead[engine] = e.code
                log.info("engine=%s row=%s error=%s", engine, i, e.code)
                return fail(e.code)
            except Exception:  # noqa: BLE001 - never keep provider text
                spend.refund(cost + extra)
                log.info("engine=%s row=%s error=provider_error", engine, i)
                return fail("provider_error")
            latency = max(0, int((clock() - t0) * 1000))
            try:
                brands, sentiment = await providers.extract(cfg["brand"], ans.text)
                method = "llm"
            except Exception:  # noqa: BLE001 - extractor failed: simple list parser instead
                spend.refund(extra)
                brands, sentiment, method = extract.heuristic_brands(ans.text), None, "heuristic"
            brands = extract.guard_brands(ans.text, brands)
            mention = matching.find_mention(ans.text, names, cfg["domain"], ans.urls)
            ours, others = extract.split_ours(brands, names)
            row = blank_row(cfg, engine, i, prompt, None, now())
            row.update(
                mentioned=mention.mentioned, mentionType=mention.mention_type,
                rank=ours["rank"] if mention.mentioned and ours else None, listLength=len(brands) or None,
                snippet=mention.snippet, competitors=others, brandCited=matching.brand_cited(ans.urls, cfg["domain"]),
                citedUrls=ans.urls, searchUsed=ans.search_used, sentiment=sentiment if mention.mentioned else None,
                extraction=method, answerText=ans.text if cfg["include_answer"] else None, latencyMs=latency)
            return row

    async def one(i: int, prompt: str, engine: str) -> None:
        row = await answer(i, prompt, engine)
        if row["status"] == "ok":
            if state["stop"]:  # the charge limit was hit while this answer was on its way: it is not delivered
                row = blank_row(cfg, engine, i, prompt, "charge_limit", now())
            elif await push(row, True):
                state["stop"] = True
        if row["status"] != "ok":
            await push(row, False)
        rows.append(row)

    await asyncio.gather(*(one(*j) for j in jobs))
    rows.sort(key=lambda r: (r["promptIndex"], cfg["engines"].index(r["engine"])))
    await set_summary(summary.build_summary(cfg["brand"], cfg["domain"], cfg["category"], cfg["engines"], rows, now()))
    ok = sum(r["status"] == "ok" for r in rows)
    failed = []
    for e in cfg["engines"]:
        codes = Counter(r["errorCode"] for r in rows if r["engine"] == e and r["status"] == "error")
        if codes:
            code, n = codes.most_common(1)[0]
            failed.append(f"{e}: {n} of {sum(r['engine'] == e for r in rows)} rows failed ({code}: {ERROR_TEXT.get(code, code)})")
    detail = ("; ".join(failed) + ".") if failed else ""
    if not ok:
        return False, f"No answer came back, nothing was charged. {detail}{notes}".strip()
    return True, f"Done: {ok} answers ({len(rows) - ok} errors, not charged). {detail}{notes}".strip()
