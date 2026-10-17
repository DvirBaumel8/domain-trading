import { readFileSync } from 'node:fs';
import { sql } from 'kysely';
import { describe, expect, it } from 'vitest';
import { testDb } from '../../helpers/db.js';

// Tech-debt S7: src/db/types.ts is hand-written (literal unions, ColumnType insert shapes, comments), so this test is the drift check:
// every table and column of the migrated schema must be in the `Database` interface with the same nullability, and the other way round.
// When it fails after a migration, edit src/db/types.ts (add/remove the column, mark `| null`), then rerun this file.

const SRC = readFileSync('src/db/types.ts', 'utf8');

function interfaceBody(name: string): string {
  const m = SRC.match(new RegExp(`export interface ${name} \\{\\n([\\s\\S]*?)\\n\\}\\n`));
  if (!m) throw new Error(`interface ${name} not found in src/db/types.ts`);
  return m[1]!;
}

/** table name -> interface name from `export interface Database`. */
const tableInterfaces = new Map<string, string>(
  [...interfaceBody('Database').matchAll(/^ {2}(\w+): (\w+);$/gm)].map((m) => [m[1]!, m[2]!]),
);

/** column -> nullable, read from the top-level members of one table interface. */
function columnsOf(iface: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const m of interfaceBody(iface).matchAll(/^ {2}(\w+)\??: (.+);$/gm)) out.set(m[1]!, /\|\s*null\b/.test(m[2]!));
  return out;
}

describe('src/db/types.ts matches the migrated schema', () => {
  it('DB-TYPES-1: same tables, same columns, same nullability', async () => {
    const rows = (
      await sql<{ table_name: string; column_name: string; is_nullable: string }>`
        SELECT c.table_name, c.column_name, c.is_nullable
        FROM information_schema.columns c
        JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
        WHERE c.table_schema = 'public' AND c.table_name <> 'pgmigrations'`.execute(testDb)
    ).rows;
    const db = new Map<string, Map<string, boolean>>();
    for (const r of rows) {
      if (!db.has(r.table_name)) db.set(r.table_name, new Map());
      db.get(r.table_name)!.set(r.column_name, r.is_nullable === 'YES');
    }
    const problems: string[] = [];
    for (const t of db.keys()) if (!tableInterfaces.has(t)) problems.push(`table ${t} is not in the Database interface`);
    for (const [t, iface] of tableInterfaces) {
      const cols = db.get(t);
      if (!cols) { problems.push(`Database.${t} has no table in the schema`); continue; }
      const typed = columnsOf(iface);
      for (const [c, nullable] of cols) {
        if (!typed.has(c)) problems.push(`${t}.${c} is missing from ${iface}`);
        else if (typed.get(c) !== nullable) problems.push(`${t}.${c} is ${nullable ? 'nullable' : 'NOT NULL'} in the schema but typed the other way`);
      }
      for (const c of typed.keys()) if (!cols.has(c)) problems.push(`${iface}.${c} has no column in the schema`);
    }
    expect(problems).toEqual([]);
  });
});
