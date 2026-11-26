"""Pure logic for the Bulk PageSpeed Checker (Google PageSpeed Insights API v5)."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

API_URL = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed"
CATEGORY_PARAM = {"performance": "PERFORMANCE", "accessibility": "ACCESSIBILITY", "best-practices": "BEST_PRACTICES", "seo": "SEO"}
LAB = {"lcpMs": "largest-contentful-paint", "cls": "cumulative-layout-shift", "tbtMs": "total-blocking-time",
       "fcpMs": "first-contentful-paint", "speedIndexMs": "speed-index", "ttiMs": "interactive"}


def normalize_url(raw) -> str | None:
    if not isinstance(raw, str) or not raw.strip():
        return None
    s = raw.strip()
    if re.match(r"(?i)(mailto|tel|javascript|data):", s):
        return None
    if "://" not in s:
        s = "https://" + s
    try:
        p = urlsplit(s)
    except ValueError:
        return None
    if p.scheme.lower() not in ("http", "https") or not p.hostname or "." not in p.hostname:
        return None
    return s


def pick(values, allowed, default):
    got = [v for v in (values or []) if v in allowed]
    return list(dict.fromkeys(got)) or list(default)


def request_params(url: str, strategy: str, categories: list[str], key: str | None) -> dict:
    p = {"url": url, "strategy": strategy, "category": [CATEGORY_PARAM[c] for c in categories]}
    if key:
        p["key"] = key
    return p


def _score(v) -> int | None:
    return None if v is None else round(float(v) * 100)


def _field(block) -> dict | None:
    """loadingExperience / originLoadingExperience -> compact Core Web Vitals, None if it has no metrics."""
    if not isinstance(block, dict) or not block.get("metrics"):
        return None
    m = block["metrics"]

    def one(name, scale=1):
        x = m.get(name)
        if not isinstance(x, dict) or x.get("percentile") is None:
            return None
        return {"value": x["percentile"] / scale if scale != 1 else x["percentile"], "category": x.get("category")}
    return {"lcpMs": one("LARGEST_CONTENTFUL_PAINT_MS"), "inpMs": one("INTERACTION_TO_NEXT_PAINT"),
            "cls": one("CUMULATIVE_LAYOUT_SHIFT_SCORE", 100), "overallCategory": block.get("overall_category")}


def parse_result(data: dict, categories: list[str]) -> dict:
    """PSI response -> the data part of a row. Raises ValueError if Lighthouse could not run."""
    lh = data.get("lighthouseResult")
    if not isinstance(lh, dict):
        raise ValueError("no Lighthouse result")
    if lh.get("runtimeError"):
        raise ValueError(f"Lighthouse error {lh['runtimeError'].get('code', 'unknown')}")
    cats = lh.get("categories") or {}
    scores = {c: _score((cats.get(c) or {}).get("score")) for c in categories}
    audits = lh.get("audits") or {}
    lab = {k: (audits.get(a) or {}).get("numericValue") for k, a in LAB.items()}
    lab = {k: (round(v, 3) if k == "cls" and v is not None else (round(v) if v is not None else None)) for k, v in lab.items()}
    le = data.get("loadingExperience") or {}
    url_level = None if le.get("origin_fallback") else _field(le)
    origin = _field(data.get("originLoadingExperience"))
    if origin is None and le.get("origin_fallback"):
        origin = _field(le)
    return {"scores": scores, "labMetrics": lab, "fieldDataPresent": url_level is not None,
            "fieldData": url_level, "originFieldData": origin}
