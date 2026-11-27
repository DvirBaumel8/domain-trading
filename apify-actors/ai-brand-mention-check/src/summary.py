"""The run summary (key `SUMMARY`): mention rate and average rank per engine, warnings, notes."""
from __future__ import annotations

NOTES = ("API answers differ from the consumer apps people use: this is a fast sampling check on small, low-cost models "
         "with web search on, one answer per question. Sentiment is an AI judgement. Answer text, quotes, cited URLs and "
         "competitor names are not exported.")


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
        "warnings": warnings,
        "notes": NOTES,
    }
