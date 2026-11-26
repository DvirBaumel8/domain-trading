"""A26-A27: no-search warning and the summary numbers."""
from helpers import Fake, drive, inp
from src import summary


def test_a26_no_search_is_flagged_and_row_is_still_returned():
    fake = Fake()
    fake.search["gemini"] = False
    res = drive(inp(promptCount=2), fake)
    gem = [r for r in res.rows if r["engine"] == "gemini"]
    assert all(r["status"] == "ok" and r["searchUsed"] is False for r in gem) and len(gem) == 2
    assert all(r["searchUsed"] is True for r in res.rows if r["engine"] != "gemini")
    assert any("2 rows had no web search" in w for w in res.summary["warnings"])


def row(engine, mentioned, rank=None, status="ok", comps=(), **kw):
    return {"engine": engine, "status": status, "mentioned": mentioned if status == "ok" else None, "rank": rank,
            "competitors": [{"name": n, "rank": i} for i, n in enumerate(comps, 1)], "errorCode": None if status == "ok" else "timeout",
            "searchUsed": True, "extraction": "llm", **kw}


def test_a27_summary_3x3_with_an_engine_with_no_mentions():
    rows = [row("chatgpt", True, 1, comps=["Trello"]), row("chatgpt", True, 3, comps=["Trello", "Jira"]), row("chatgpt", False, comps=["Jira"]),
            row("gemini", False), row("gemini", False), row("gemini", False),
            row("claude", True, 2, comps=["Trello"]), row("claude", True, None), row("claude", False, status="error")]
    s = summary.build_summary("Asana", "asana.com", "pm", ["chatgpt", "gemini", "claude"], rows, "2026-11-26T00:00:00+00:00")
    assert s["engines"]["chatgpt"] == {"rowsOk": 3, "rowsError": 0, "mentionRate": 0.6667, "avgRank": 2.0, "mentionedCount": 2}
    assert s["engines"]["gemini"] == {"rowsOk": 3, "rowsError": 0, "mentionRate": 0.0, "avgRank": None, "mentionedCount": 0}
    assert s["engines"]["claude"] == {"rowsOk": 2, "rowsError": 1, "mentionRate": 1.0, "avgRank": 2.0, "mentionedCount": 2}
    assert s["overall"] == {"rowsOk": 8, "rowsError": 1, "mentionRate": 0.5, "avgRank": 2.0, "mentionedCount": 4}
    top = s["topCompetitors"]
    assert top[0] == {"name": "Trello", "rows": 3, "avgRank": 1.0} and top[1]["name"] == "Jira" and top[1]["rows"] == 2 and top[1]["avgRank"] == 1.5
    assert any("claude: 1 rows not answered (timeout)" in w for w in s["warnings"])
    assert "differ from the consumer apps" in s["notes"] and len(top) <= 10


def test_a27_summary_is_saved_by_the_run():
    res = drive(inp(promptCount=2))
    s = res.summary
    assert set(s["engines"]) == {"chatgpt", "gemini", "claude"} and s["overall"]["rowsOk"] == 6 and s["overall"]["mentionRate"] == 1.0
    assert s["overall"]["avgRank"] == 1.0 and {c["name"] for c in s["topCompetitors"]} == {"Trello", "Monday.com"}
