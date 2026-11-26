"""Build cached market data for the instant free check from a saved run (no new queries).
python3 build_market_cache.py --niche dentist --city "Austin, TX" --answers ... --roster ... --source-note "..." --data-date YYYY-MM-DD
"""
import argparse, datetime, json, os, re, sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "engine"))
from aivis.audit import result_from_saved
from aivis.niches import get_niche
from aivis.roster import from_csv

ap = argparse.ArgumentParser()
ap.add_argument("--niche", required=True); ap.add_argument("--city", required=True)
ap.add_argument("--answers", required=True); ap.add_argument("--roster", required=True)
ap.add_argument("--source-note", required=True)
ap.add_argument("--data-date", required=True, help="ISO date (YYYY-MM-DD) the AI answers were collected")
a = ap.parse_args()
try:
    if not re.fullmatch(r"\d{4}-\d{2}-\d{2}", a.data_date):
        raise ValueError
    datetime.date.fromisoformat(a.data_date)
except ValueError:
    ap.error("--data-date must be a real date like 2026-11-25")
niche = get_niche(a.niche)
roster = [e.name for e in from_csv(a.roster)]
res = result_from_saved(niche, a.city, "__none__", json.load(open(a.answers)), roster)
answers = [{"names": [m.roster_name or m.raw for m in ms], "raw": [m.raw for m in ms],
            "matched": [m.verified for m in ms]} for _, ms, _ in res.records]
allm = [m for _, ms, _ in res.records for m in ms]
unv = sum(1 for m in allm if not m.verified)
data = {"niche": a.niche, "niche_label": niche.plural, "city": a.city, "answers": answers,
        "competitors": len({m.roster_name for m in allm if m.verified}),
        "unverified_pct": round(100 * unv / len(allm)) if allm else 0, "source_note": a.source_note,
        "data_date": a.data_date}
slug = f"{a.niche}__{a.city.lower().replace(',', '').replace(' ', '-')}"
out = os.path.join(os.path.dirname(__file__), "data", "markets", slug + ".json")
with open(out, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=1)
print("wrote", out, "answers", len(answers), "competitors", data["competitors"], "unverified%", data["unverified_pct"])
