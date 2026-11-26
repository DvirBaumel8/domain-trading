"""The run summary (key `SUMMARY`): mention rate and average rank per engine, top competitors, warnings, notes."""
from __future__ import annotations

NOTES = ("API answers differ from the consumer apps (ChatGPT, Gemini and Claude as people use them): this is a fast sampling "
         "check on small, low-cost models with web search on, one answer per question. Sentiment is an AI judgement.")
TOP_COMPETITORS = 10


def _stats(rows: list[dict]) -> dict:
    ok = [r for r in rows if r["status"] == "ok"]
    hits = [r for r in ok if r["mentioned"]]
    ranks = [r["rank"] for r in hits if r.get("rank") is not None]
    return {
        "rowsOk": len(ok),
        "rowsError": len(rows) - len(ok),
        "mentionRate": round(len(hits) / len(ok), 4) if ok else None,
        "avgRank": round(sum(ranks) / len(ranks), 2) if ranks else None,
        "mentionedCount": len(hits),
    }


def top_competitors(rows: list[dict]) -> list[dict]:
    seen: dict[str, dict] = {}
    for r in rows:
        if r["status"] != "ok":
            continue
        for c in {c["name"].lower(): c for c in r.get("competitors") or []}.values():
            e = seen.setdefault(c["name"].lower(), {"name": c["name"], "rows": 0, "ranks": []})
            e["rows"] += 1
            if c.get("rank") is not None:
                e["ranks"].append(c["rank"])
    out = [{"name": e["name"], "rows": e["rows"], "avgRank": round(sum(e["ranks"]) / len(e["ranks"]), 2) if e["ranks"] else None}
           for e in seen.values()]
    out.sort(key=lambda e: (-e["rows"], e["avgRank"] if e["avgRank"] is not None else 1e9, e["name"].lower()))
    return out[:TOP_COMPETITORS]


def build_summary(brand: str, domain: str | None, category: str | None, engines: list[str], rows: list[dict], generated_at: str) -> dict:
    warnings = []
    no_search = sum(1 for r in rows if r["status"] == "ok" and r.get("searchUsed") is False)
    if no_search:
        warnings.append(f"{no_search} rows had no web search: those answers may come from the model's memory.")
    heuristic = sum(1 for r in rows if r["status"] == "ok" and r.get("extraction") == "heuristic")
    if heuristic:
        warnings.append(f"{heuristic} rows used the simple list parser because the extractor call failed (no sentiment for them).")
    for e in engines:
        codes: dict[str, int] = {}
        for r in rows:
            if r["engine"] == e and r["status"] == "error":
                codes[r["errorCode"]] = codes.get(r["errorCode"], 0) + 1
        for code, n in sorted(codes.items()):
            warnings.append(f"{e}: {n} rows not answered ({code}).")
    return {
        "brand": brand, "domain": domain, "category": category, "generatedAt": generated_at,
        "engines": {e: _stats([r for r in rows if r["engine"] == e]) for e in engines},
        "overall": _stats(rows),
        "topCompetitors": top_competitors(rows),
        "warnings": warnings,
        "notes": NOTES,
    }
