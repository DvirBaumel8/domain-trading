"""SQLite storage for runs, answers and mentions (DOM will port this to its DB)."""
import json
import sqlite3
import time

SCHEMA = """
CREATE TABLE IF NOT EXISTS runs (id INTEGER PRIMARY KEY, created REAL, niche TEXT, city TEXT, target TEXT,
  providers TEXT, n_prompts INTEGER, repeats INTEGER, score INTEGER, label TEXT);
CREATE TABLE IF NOT EXISTS answers (id INTEGER PRIMARY KEY, run_id INTEGER, provider TEXT, model TEXT, mode TEXT,
  prompt TEXT, intent TEXT, repeat INTEGER, text TEXT, citations TEXT, cost_usd REAL);
CREATE TABLE IF NOT EXISTS mentions (id INTEGER PRIMARY KEY, answer_id INTEGER, raw TEXT, position INTEGER,
  roster_name TEXT);
"""


class Store:
    def __init__(self, path=":memory:"):
        self.db = sqlite3.connect(path)
        self.db.executescript(SCHEMA)

    def save(self, niche, city, target, providers, n_prompts, repeats, score, records, label=""):
        cur = self.db.cursor()
        cur.execute("INSERT INTO runs(created,niche,city,target,providers,n_prompts,repeats,score,label) "
                    "VALUES (?,?,?,?,?,?,?,?,?)",
                    (time.time(), niche, city, target, ",".join(providers), n_prompts, repeats, score, label))
        run_id = cur.lastrowid
        for ans, mentions, intent in records:
            cur.execute("INSERT INTO answers(run_id,provider,model,mode,prompt,intent,repeat,text,citations,cost_usd)"
                        " VALUES (?,?,?,?,?,?,?,?,?,?)",
                        (run_id, ans.provider, ans.model, ans.mode, ans.prompt, intent, ans.run, ans.text,
                         json.dumps(ans.citations), ans.cost_usd))
            aid = cur.lastrowid
            cur.executemany("INSERT INTO mentions(answer_id,raw,position,roster_name) VALUES (?,?,?,?)",
                            [(aid, m.raw, m.position, m.roster_name) for m in mentions])
        self.db.commit()
        return run_id

    def count(self, table):
        return self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
