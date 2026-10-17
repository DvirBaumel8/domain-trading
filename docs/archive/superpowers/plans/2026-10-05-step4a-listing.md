# Step 4a: `/list`, marketplace exports, NS verification: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `POST /list/{domain}` (listing changes with V1–V10, lander nameservers through the registrar or a manual fallback, `listing_history`, dry-run export preview), `GET /export/afternic.csv` (byte-exact header, cells per mode) and `GET /export/sedo.csv` (template-driven; 501 without the template), and the public-DNS NS verification (an immediate check plus a daily job). Gate G1 for L-1–L-9, L-11, L-13, E-1–E-8, LX-1–LX-7, LH-1, LH-2, LH-4, and the endpoint-level LS/LG cases (LS-14, LG-4, LG-11–LG-14); the remaining LS/LG cases are covered by the step-3 validator tests.

**Architecture:**
- **`ListService` (`src/services/list.ts`):** classify the request (listing change, category change, NS-only), enforce V9/V10 approval rules, run the step-3 validator, then dry-run preview **or** NS change (adapter, or manual for `registrar_api=none`), then save and append history.
- **`ExportService` (`src/services/export.ts`):** builds pure Afternic and Sedo rows from domain rows. The CSV is written by a tiny RFC 4180 writer.
- **Public DNS:** a small dependency-free NS query to `a.gtld-servers.net` (`src/dns/ns-lookup.ts`) that reads the referral's authority section, injected everywhere so tests never send UDP.
- **NS verification:** `NsVerifier` runs at startup and every 24 h.

**Tech Stack:** As before. `node:dgram` for the DNS query (no new dependency).

**Spec:** `docs/specs/list.md`, `docs/specs/listing-strategy.md` §2, §4–§6, §9, `docs/specs/export-csv.md`, `CLAUDE.md` (Afternic header; Sedo headers only from `templates/sedo_template.json`, never guessed), `docs/specs/00-architecture.md` §4.

## Global Constraints

- Everything in the step 1–3 Global Constraints still holds (cents, error envelope, idempotency + audit on every POST, no network in tests, fake keys, ESM `.js` imports, branch on registrar codes, never edit a spec test to pass).
- **Afternic header, byte-exact:** `Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden`. CRLF line endings, UTF-8, RFC 4180 quoting, `Content-Disposition: attachment; filename="afternic-YYYY-MM-DD.csv"` (Asia/Jerusalem date). Never generate a "Replace" file.
- **Afternic cells per mode (listing-strategy §6, binding):**
  - bin: `BIN,BIN,BIN,N,,Buy It Now,Y,N,N,N`
  - offer: `0,<floor or blank>,<min>,N,,Custom Lander,N,N,Y,N`
  - hybrid: `BIN,floor,min,<Y if LTO else N>,<months or blank>,Custom Lander,Y,<Y if LTO else N>,Y,N`
  
  Prices are integer USD, rounded **down** from cents with an `AFTERNIC_ROUNDS_DOWN` warning. `Min Offer` < 20 is never exported: the row is skipped and reported in `X-Export-Warnings`.
- **Sedo:** headers and values come only from `templates/sedo_template.json` (path override `SEDO_TEMPLATE_PATH`). Without the file → **501 `SEDO_TEMPLATE_MISSING`**. Fixed-price rows have no minimum price.
- **`/list` approvals:** `approval_ref` is required when the mode, any price or the category changes (V10 / V9 → 422 `APPROVAL_REQUIRED`). If sent, it must be valid (`APPROVAL_INVALID`/`APPROVAL_EXPIRED`, the step-3 label-boundary rule). An NS-only request needs no approval. A high-value → `geo` category change needs `override` + reason + valid approval (`OVERRIDE_NEEDS_APPROVAL`).
- **Strict schema:** unknown fields → 422 `VALIDATION_ERROR` (LS-14, LG-12).
- **Landers:** `afternic` → `ns1/ns2.afternic.com`; `sedo` → `ns1/ns2.sedoparking.com`; `custom` → `ns` with 2–4 valid hostnames; `dan` → 422 `LANDER_RETIRED` ("Dan.com retired 2025-06-27; use afternic").
- **NS compare as sets** (order and case don't matter; trailing dot ignored).
- **No UDP in tests:** every DNS lookup goes through the injected `NsLookup`. `makeApp` defaults it to a stub that returns `null`.
- **Read-only GETs stay read-only except the export run log:** `GET /export/afternic.csv` records an `export_runs` row, so `X-Manual-Delist` can list what was sold or dropped since the previous export.

## Review Focus

1. **A listing change arrives for a domain whose registrar can't set NS** (`registrar_api=none`, e.g. GoDaddy without a PAT): prices must still be saved, the response is `ns_status:"manual"` with exact steps, and there are zero registrar calls. Test L-11 in Task 3.
2. **Relabel to dodge the guard:** `trend` → `geo` with a cheap BIN, no override → 422 `OVERRIDE_NEEDS_APPROVAL`. A category change alone, with no prices sent, re-validates the existing listing under the new category. Tests LG-11 and "category change re-validates" in Task 3.
3. **Mode switch hybrid → offer, then export:** Buy Now Price must be `0`, not blank, or Afternic might keep the old BIN. Test LX-7 in Task 2.
4. **A display name containing a comma or quote**, or one that doesn't match the domain: it is RFC 4180-quoted in the CSV, and `/list` rejects a `display_name` that doesn't lowercase to the domain. Tests in Tasks 2 and 3.
5. **A malformed or truncated DNS response, or an NS server timeout:** returns `null` (unknown), never a false "verified". Tests in Task 1.

## Decisions taken in this plan that the spec doesn't spell out (Dvir to confirm)

| # | Decision | Why |
|---|---|---|
| L1 | **GoDaddy NS (L-12) moves to step 4b** together with the GoDaddy adapter and `import-domain`. In 4a, a `manage` domain with no GoDaddy adapter is handled as `manual` | The adapter is needed for import anyway; keeps 4a focused |
| L2 | Any price or category field in the request counts as a change (needs approval). A request with none of them is NS-only | Simple and strict; resending the same price with approval is harmless |
| L3 | A category change without prices **re-validates the current listing** under the new category; failure → 422 | Otherwise a relabel could leave an invalid listing in place |
| L4 | `display_name` must lowercase to the domain, else 422 `DISPLAY_NAME_MISMATCH` | Prevents exporting the wrong name to Afternic |
| L5 | NS failure order follows list.md: NS (step 4) runs before saving (step 5), so `API_ACCESS_DISABLED` → 409 and **nothing is saved** (L-6). Other registrar errors → 409 `REGISTRAR_REJECTED` with `registrar_code` | Spec order |
| L6 | The immediate public-DNS check after an NS change returns `ns_public: "match" \| "pending" \| "unknown"`; `ns_verified_at` is set only on a match and cleared whenever the NS target changes. The daily job re-checks every domain with a lander target, sets `ns_verified_at` on a match and clears it on a mismatch (lookup errors change nothing) | list.md step 4 + L-13 |
| L7 | New table `export_runs (id, marketplace, at, domains text[])` and column `domains.delisted_at` (set by `/sold` and the drop job in 4b). `X-Manual-Delist` lists sold/dropped domains with `delisted_at` after the previous Afternic export (all such domains on the first export) | export-csv.md "sold or dropped since the last export" |
| L8 | Listing prices keep cents in storage and responses (`presentListing` shows `399.5`); only the Afternic export rounds down (with a warning) | listing-strategy §4 |
| L9 | The DNS server is `192.5.6.30` (`a.gtld-servers.net`), overridable with `DNS_NS_SERVER`; query timeout 3 s | list.md |

---

## File structure

```
migrations/1759800000000_listing.sql   export_runs table; domains.delisted_at
src/
  dns/ns-lookup.ts          encodeNsQuery, parseNsResponse, queryNs, type NsLookup
  services/export.ts        afternicRow, sedoRow, loadSedoTemplate, toCsv, AFTERNIC_HEADER
  services/list.ts          ListService
  jobs/ns-verify.ts         NsVerifier
  api/export.ts             GET /export/afternic.csv, GET /export/sedo.csv
  api/list.ts               POST /list/:domain
  app.ts                    (modify) wire ExportService, ListService, NsVerifier (decorate app.nsVerifier), AppDeps.nsLookup
  main.ts                   (modify) NsVerifier at startup + every 24 h
  config.ts                 (modify) SEDO_TEMPLATE_PATH, DNS_NS_SERVER
  db/types.ts               (modify) ExportRunsTable, domains.delisted_at
tests/
  unit/ns-lookup.test.ts, export-rows.test.ts
  api/export.test.ts, list.test.ts, ns-verify.test.ts
  helpers/app.ts            (modify) nsLookup passthrough (default: async () => null), sedoTemplatePath
  helpers/listing.ts        listedDomain(db, over) fixture
  helpers/csv.ts            strict RFC 4180 parser (test-only)
```

---

### Task 1: Migration 3 + public-DNS NS lookup

**Files:**
- Create: `migrations/1759800000000_listing.sql`, `src/dns/ns-lookup.ts`, `tests/unit/ns-lookup.test.ts`
- Modify: `src/db/types.ts`, `src/config.ts`, `tests/unit/config.test.ts`, `tests/api/admin-cli.test.ts` (migrations count 2 → 3)

**Interfaces:**
- Produces:
  - `type NsLookup = (domain: string) => Promise<string[] | null>` (lowercased NS names without a trailing dot; `null` = unknown)
  - `encodeNsQuery(domain: string, id: number): Buffer`
  - `parseNsResponse(buf: Buffer, domain: string, id: number): string[] | null`
  - `queryNs(domain: string, opts?: { server?: string; timeoutMs?: number }): Promise<string[] | null>` (never throws)
  - `Config` gains `sedoTemplatePath: string` (default `templates/sedo_template.json`) and `dnsNsServer: string` (default `192.5.6.30`)
  - `ExportRunsTable { id: Generated<number>; marketplace: 'afternic' | 'sedo'; at: TimestampDefault; domains: string[] }`; `DomainsTable.delisted_at: Timestamp | null`

- [ ] **Step 1: Migration + types + config**

`migrations/1759800000000_listing.sql`:
```sql
-- Up Migration

CREATE TABLE export_runs (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  marketplace  text NOT NULL CHECK (marketplace IN ('afternic', 'sedo')),
  at           timestamptz NOT NULL DEFAULT now(),
  domains      text[] NOT NULL DEFAULT '{}'
);
CREATE INDEX export_runs_marketplace_at ON export_runs (marketplace, at);
ALTER TABLE domains ADD COLUMN delisted_at timestamptz;

-- Down Migration

ALTER TABLE domains DROP COLUMN delisted_at;
DROP TABLE export_runs;
```
Add `export_runs` to `TABLES` in `tests/helpers/db.ts` (so `resetDb` truncates it). Add `ExportRunsTable` to `Database` and `delisted_at: Timestamp | null` to `DomainsTable` in `src/db/types.ts`. In `src/config.ts` read `SEDO_TEMPLATE_PATH` (default `templates/sedo_template.json`) and `DNS_NS_SERVER` (default `192.5.6.30`) into `sedoTemplatePath` / `dnsNsServer`, and add a config test that asserts both defaults. Change `/migrations: 2 applied/` to `/migrations: 3 applied/` in `tests/api/admin-cli.test.ts`. Run `npm run migrate up` for the dev DB.

- [ ] **Step 2: Write the failing DNS tests**

`tests/unit/ns-lookup.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { encodeNsQuery, parseNsResponse } from '../../src/dns/ns-lookup.js';

/** Test-only encoder for a DNS response carrying NS records in the answer or authority section. */
function encodeName(name: string): Buffer {
  const parts = name.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  return Buffer.concat([...parts, Buffer.from([0])]);
}
function nsRecord(owner: Buffer, target: Buffer): Buffer {
  const fixed = Buffer.alloc(10);
  fixed.writeUInt16BE(2, 0); // type NS
  fixed.writeUInt16BE(1, 2); // class IN
  fixed.writeUInt32BE(172800, 4);
  fixed.writeUInt16BE(target.length, 8);
  return Buffer.concat([owner, fixed, target]);
}
function response(id: number, domain: string, ns: string[], section: 'answer' | 'authority', opts: { rcode?: number; compress?: boolean; tc?: boolean } = {}): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x8000 | (opts.tc ? 0x0200 : 0) | (opts.rcode ?? 0), 2);
  header.writeUInt16BE(1, 4); // qdcount
  header.writeUInt16BE(section === 'answer' ? ns.length : 0, 6);
  header.writeUInt16BE(section === 'authority' ? ns.length : 0, 8);
  const qname = encodeName(domain);
  const qfixed = Buffer.from([0, 2, 0, 1]);
  // Owner name: a compression pointer to the question name at offset 12, or the full name.
  const owner = opts.compress ? Buffer.from([0xc0, 12]) : qname;
  const rrs = ns.map((n) => nsRecord(owner, encodeName(n)));
  return Buffer.concat([header, qname, qfixed, ...rrs]);
}

describe('NS query encoding', () => {
  it('builds a standard NS/IN query for the domain with the given id', () => {
    const q = encodeNsQuery('example.com', 0x1234);
    expect(q.readUInt16BE(0)).toBe(0x1234);
    expect(q.readUInt16BE(4)).toBe(1); // one question
    expect(q.subarray(12).toString('hex')).toBe(`${encodeName('example.com').toString('hex')}00020001`);
  });
});

describe('parseNsResponse', () => {
  it('reads NS from the authority section (gTLD referral), lowercased, deduped', () => {
    const r = response(7, 'example.com', ['NS1.Afternic.com', 'ns2.afternic.com'], 'authority');
    expect(parseNsResponse(r, 'example.com', 7)?.sort()).toEqual(['ns1.afternic.com', 'ns2.afternic.com']);
  });
  it('reads NS from the answer section and handles name compression', () => {
    const r = response(9, 'example.com', ['ns1.sedoparking.com', 'ns2.sedoparking.com'], 'answer', { compress: true });
    expect(parseNsResponse(r, 'example.com', 9)?.sort()).toEqual(['ns1.sedoparking.com', 'ns2.sedoparking.com']);
  });
  it('Review Focus 5: wrong id, NXDOMAIN, truncated, or garbage → null (never a false match)', () => {
    expect(parseNsResponse(response(1, 'example.com', ['ns1.x.com'], 'authority'), 'example.com', 2)).toBeNull();
    expect(parseNsResponse(response(3, 'example.com', [], 'authority', { rcode: 3 }), 'example.com', 3)).toBeNull();
    expect(parseNsResponse(response(4, 'example.com', ['ns1.x.com'], 'authority', { tc: true }), 'example.com', 4)).toBeNull();
    expect(parseNsResponse(Buffer.from([1, 2, 3]), 'example.com', 1)).toBeNull();
    const cut = response(5, 'example.com', ['ns1.x.com'], 'authority');
    expect(parseNsResponse(cut.subarray(0, cut.length - 4), 'example.com', 5)).toBeNull();
  });
  it('ignores NS records owned by another name', () => {
    const r = response(6, 'other.com', ['ns1.x.com'], 'authority');
    expect(parseNsResponse(r, 'example.com', 6)).toEqual([]);
  });
  it('a pointer loop does not hang → null', () => {
    const r = response(8, 'example.com', ['ns1.x.com'], 'authority');
    // Corrupt the first RR owner into a pointer to itself.
    const ownerOffset = 12 + encodeName('example.com').length + 4;
    r.writeUInt8(0xc0, ownerOffset);
    r.writeUInt8(ownerOffset, ownerOffset + 1);
    expect(parseNsResponse(r, 'example.com', 8)).toBeNull();
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run tests/unit/ns-lookup.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 4: Implement**

`src/dns/ns-lookup.ts`:
```ts
import { randomInt } from 'node:crypto';
import dgram from 'node:dgram';

/** NS names (lowercase, no trailing dot) as seen by the .com registry; null = couldn't tell. */
export type NsLookup = (domain: string) => Promise<string[] | null>;

const TYPE_NS = 2;
const CLASS_IN = 1;

export function encodeNsQuery(domain: string, id: number): Buffer {
  const header = Buffer.alloc(12);
  header.writeUInt16BE(id, 0);
  header.writeUInt16BE(0x0000, 2); // standard query, RD=0 (we ask the registry server directly)
  header.writeUInt16BE(1, 4);
  const labels = domain.replace(/\.$/, '').split('.').map((l) => Buffer.concat([Buffer.from([l.length]), Buffer.from(l, 'ascii')]));
  const tail = Buffer.alloc(4);
  tail.writeUInt16BE(TYPE_NS, 0);
  tail.writeUInt16BE(CLASS_IN, 2);
  return Buffer.concat([header, ...labels, Buffer.from([0]), tail]);
}

/** Read a (possibly compressed) name at `offset`. Returns the name and the offset after it in the original stream. */
function readName(buf: Buffer, offset: number): { name: string; next: number } {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  for (let jumps = 0; jumps < 32; jumps++) {
    if (pos >= buf.length) throw new Error('truncated');
    const len = buf[pos]!;
    if (len === 0) {
      return { name: labels.join('.').toLowerCase(), next: next === -1 ? pos + 1 : next };
    }
    if ((len & 0xc0) === 0xc0) {
      if (pos + 1 >= buf.length) throw new Error('truncated');
      const ptr = ((len & 0x3f) << 8) | buf[pos + 1]!;
      if (next === -1) next = pos + 2;
      pos = ptr;
      continue;
    }
    if (pos + 1 + len > buf.length) throw new Error('truncated');
    labels.push(buf.toString('ascii', pos + 1, pos + 1 + len));
    pos += 1 + len;
  }
  throw new Error('pointer loop');
}

export function parseNsResponse(buf: Buffer, domain: string, id: number): string[] | null {
  try {
    if (buf.length < 12 || buf.readUInt16BE(0) !== id) return null;
    const flags = buf.readUInt16BE(2);
    if (!(flags & 0x8000) || flags & 0x0200 || (flags & 0x000f) !== 0) return null; // not a response, truncated, or rcode≠0
    const qd = buf.readUInt16BE(4);
    const an = buf.readUInt16BE(6);
    const ns = buf.readUInt16BE(8);
    let pos = 12;
    for (let i = 0; i < qd; i++) pos = readName(buf, pos).next + 4;
    const want = domain.toLowerCase().replace(/\.$/, '');
    const out = new Set<string>();
    for (let i = 0; i < an + ns; i++) {
      const owner = readName(buf, pos);
      pos = owner.next;
      if (pos + 10 > buf.length) return null;
      const type = buf.readUInt16BE(pos);
      const rdlen = buf.readUInt16BE(pos + 8);
      const rdata = pos + 10;
      if (rdata + rdlen > buf.length) return null;
      if (type === TYPE_NS && owner.name === want) out.add(readName(buf, rdata).name);
      pos = rdata + rdlen;
    }
    return [...out];
  } catch {
    return null;
  }
}

/** One UDP query to the registry server. Never throws; null on timeout or a bad answer. */
export function queryNs(domain: string, opts: { server?: string; timeoutMs?: number } = {}): Promise<string[] | null> {
  const id = randomInt(0, 0x10000);
  const msg = encodeNsQuery(domain, id);
  return new Promise((resolve) => {
    const sock = dgram.createSocket('udp4');
    const done = (v: string[] | null) => {
      clearTimeout(timer);
      sock.close();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), opts.timeoutMs ?? 3000);
    sock.on('error', () => done(null));
    sock.on('message', (buf) => done(parseNsResponse(buf, domain, id)));
    sock.send(msg, 53, opts.server ?? '192.5.6.30', (err) => {
      if (err) done(null);
    });
  });
}
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 6: Commit**
```bash
git add migrations/ src/ tests/
git commit -m "feat: migration 3 (export_runs, delisted_at); dependency-free public-DNS NS lookup"
```

---

### Task 2: Afternic and Sedo exports

**Files:**
- Create: `src/services/export.ts`, `src/api/export.ts`, `tests/helpers/csv.ts`, `tests/helpers/listing.ts`, `tests/unit/export-rows.test.ts`, `tests/api/export.test.ts`
- Modify: `src/app.ts`, `tests/helpers/app.ts`

**Interfaces:**
- Consumes: `Config.sedoTemplatePath`, `jerusalemDate`, `Database`, `testDb`, `insertOwnedDomain`.
- Produces:
  - `AFTERNIC_HEADER: readonly string[]` (11 columns)
  - `type ExportDomain = Pick<DomainRow, 'domain' | 'display_name' | 'listing_mode' | 'bin_cents' | 'floor_cents' | 'min_offer_cents' | 'lto_max_months'>`
  - `afternicRow(d: ExportDomain): { cells: string[] } | { skip: string }` plus a `warnings: string[]` array returned alongside (see code)
  - `interface SedoTemplate { headers: string[]; map: Record<'domain'|'selling_option'|'for_sale'|'price'|'min_price'|'currency'|'action', string>; values: Record<'buy_now'|'make_offer'|'for_sale_yes'|'usd'|'action_add', string> }`
  - `loadSedoTemplate(path: string): Promise<SedoTemplate | null>` (null if the file is missing; throws on an invalid file)
  - `sedoRow(d: ExportDomain, t: SedoTemplate, hybridAs: 'buy_now' | 'make_offer'): string[]`
  - `toCsv(rows: string[][]): string` (RFC 4180, CRLF, trailing CRLF)
  - `class ExportService { constructor(deps: { db; config: Config; now: () => number }); afternic(): Promise<{ csv: string; filename: string; delist: string[]; warnings: string[] }>; sedo(): Promise<{ csv: string; filename: string; warnings: string[] } | null> }`
  - `registerExport(app, service: ExportService): void`
  - Test helpers: `parseCsvStrict(text: string): string[][]`; `listedDomain(db, over: Partial<DomainInsert>): Promise<number>`; `makeApp({ sedoTemplatePath })` passthrough (env override)

- [ ] **Step 1: Test helpers and failing tests**

`tests/helpers/csv.ts`:
```ts
/** Strict RFC 4180 parser for tests: CRLF records, quoted fields, "" escapes. Throws on anything else. */
export function parseCsvStrict(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let i = 0;
  let quoted = false;
  let fieldStarted = false;
  while (i < text.length) {
    const c = text[i]!;
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        quoted = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') {
      if (fieldStarted) throw new Error(`quote inside unquoted field at ${i}`);
      quoted = true; fieldStarted = true; i++; continue;
    }
    if (c === ',') { row.push(field); field = ''; fieldStarted = false; i++; continue; }
    if (c === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      row.push(field); rows.push(row); row = []; field = ''; fieldStarted = false; i += 2; continue;
    }
    if (c === '\n') throw new Error(`bare LF at ${i}`);
    field += c; fieldStarted = true; i++;
  }
  if (quoted) throw new Error('unterminated quote');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
```
`tests/helpers/listing.ts`:
```ts
import type { DomainInsert } from '../../src/db/types.js';
import { insertOwnedDomain, testDb } from './db.js';

export function listedDomain(over: Partial<DomainInsert> = {}): Promise<number> {
  return insertOwnedDomain(testDb, { status: 'listed', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900, ...over });
}
```
`tests/unit/export-rows.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { AFTERNIC_HEADER, afternicRow, sedoRow, toCsv, type ExportDomain, type SedoTemplate } from '../../src/services/export.js';

const d = (over: Partial<ExportDomain>): ExportDomain => ({
  domain: 'example.com', display_name: null, listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900, lto_max_months: null, ...over,
});
const cells = (r: ReturnType<typeof afternicRow>) => ('cells' in r.row ? r.row.cells.join(',') : `SKIP:${r.row.skip}`);

describe('Afternic rows (listing-strategy §6)', () => {
  it('E-1: header byte for byte', () => {
    expect(AFTERNIC_HEADER.join(',')).toBe('Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden');
  });
  it('LX-1: bin 399', () => expect(cells(afternicRow(d({})))).toBe('example.com,399,399,399,N,,Buy It Now,Y,N,N,N'));
  it('LX-2: offer min 500, no floor', () =>
    expect(cells(afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 })))).toBe('example.com,0,,500,N,,Custom Lander,N,N,Y,N'));
  it('LX-3: hybrid 1995/950/950, no LTO', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 })))).toBe('example.com,1995,950,950,N,,Custom Lander,Y,N,Y,N'));
  it('LX-4: hybrid + LTO 24, BIN 4999', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 499900, floor_cents: 250000, min_offer_cents: 100000, lto_max_months: 24 })))).toBe('example.com,4999,2500,1000,Y,24,Custom Lander,Y,Y,Y,N'));
  it('LX-7: offer mode writes 0 for Buy Now Price, never blank', () =>
    expect(cells(afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: 60000, min_offer_cents: 50000 })))).toBe('example.com,0,600,500,N,,Custom Lander,N,N,Y,N'));
  it('E-4: integer USD, no symbol or separator', () =>
    expect(cells(afternicRow(d({ listing_mode: 'hybrid', bin_cents: 12345600, floor_cents: 1000000, min_offer_cents: 500000 })))).toBe('example.com,123456,10000,5000,N,,Custom Lander,Y,N,Y,N'));
  it('cents round DOWN with AFTERNIC_ROUNDS_DOWN', () => {
    const r = afternicRow(d({ bin_cents: 39950, floor_cents: 39950, min_offer_cents: 39950 }));
    expect(cells(r)).toBe('example.com,399,399,399,N,,Buy It Now,Y,N,N,N');
    expect(r.warnings).toEqual(['example.com:AFTERNIC_ROUNDS_DOWN']);
  });
  it('E-3/LX-6: Min Offer below 20 → skipped with a warning', () => {
    const r = afternicRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 1999 }));
    expect(cells(r)).toBe('SKIP:MIN_OFFER_BELOW_20');
    expect(r.warnings).toEqual(['example.com:MIN_OFFER_BELOW_20']);
  });
  it('uses display_name when set', () => expect(cells(afternicRow(d({ display_name: 'ExampleCityRoofing.com' })))).toMatch(/^ExampleCityRoofing\.com,/));
  it('no listing mode → skipped', () => expect(cells(afternicRow(d({ listing_mode: null })))).toBe('SKIP:NOT_LISTED'));
});

describe('toCsv (RFC 4180)', () => {
  it('CRLF, quotes fields with comma/quote/CR/LF, doubles quotes', () => {
    expect(toCsv([['a', 'b,c', 'd"e', 'f\ng'], ['1', '', '2', '3']])).toBe('a,"b,c","d""e","f\ng"\r\n1,,2,3\r\n');
  });
});

const T: SedoTemplate = {
  headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action', 'Notes'],
  map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
  values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
};

describe('Sedo rows (LX-5)', () => {
  it('bin → fixed + price + no min', () => expect(sedoRow(d({}), T, 'buy_now')).toEqual(['example.com', 'FIXED', 'yes', '399', '', 'USD', 'ADD', '']));
  it('offer → make offer + min, no price', () =>
    expect(sedoRow(d({ listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 }), T, 'buy_now')).toEqual(['example.com', 'OFFER', 'yes', '', '500', 'USD', 'ADD', '']));
  it('hybrid default (buy_now) → fixed + BIN + no min', () =>
    expect(sedoRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 }), T, 'buy_now')).toEqual(['example.com', 'FIXED', 'yes', '1995', '', 'USD', 'ADD', '']));
  it('hybrid make_offer → make offer + price expectation + min', () =>
    expect(sedoRow(d({ listing_mode: 'hybrid', bin_cents: 199500, floor_cents: 95000, min_offer_cents: 95000 }), T, 'make_offer')).toEqual(['example.com', 'OFFER', 'yes', '1995', '950', 'USD', 'ADD', '']));
});
```
`tests/api/export.test.ts`:
```ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { makeApp } from '../helpers/app.js';
import { parseCsvStrict } from '../helpers/csv.js';
import { testDb as db } from '../helpers/db.js';
import { listedDomain } from '../helpers/listing.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());

async function fixture4() {
  await listedDomain({ domain: 'austinroofrepair.com', display_name: 'AustinRoofRepair.com', category: 'geo' });
  await listedDomain({ domain: 'trendname.com', category: 'trend', listing_mode: 'hybrid', bin_cents: 499900, floor_cents: 250000, min_offer_cents: 100000, lto_max_months: 24 });
  await listedDomain({ domain: 'buzz.com', category: 'buzzword', listing_mode: 'offer', bin_cents: null, floor_cents: null, min_offer_cents: 50000 });
  await listedDomain({ domain: 'gone.com', status: 'sold', sold_at: new Date(), delisted_at: new Date() });
}

describe('GET /export/afternic.csv', () => {
  it('E-2/E-5: 3 rows exactly (LX-1/LX-4/LX-2), sorted by domain, sold excluded + in X-Manual-Delist; strict parse 11 columns', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await fixture4();
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/csv; charset=utf-8/);
    expect(res.headers['content-disposition']).toMatch(/^attachment; filename="afternic-\d{4}-\d{2}-\d{2}\.csv"$/);
    expect(res.headers['x-manual-delist']).toBe('gone.com');
    const rows = parseCsvStrict(res.body);
    expect(rows.every((r) => r.length === 11)).toBe(true);
    expect(rows.map((r) => r.join(','))).toEqual([
      'Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden',
      'AustinRoofRepair.com,399,399,399,N,,Buy It Now,Y,N,N,N',
      'buzz.com,0,,500,N,,Custom Lander,N,N,Y,N',
      'trendname.com,4999,2500,1000,Y,24,Custom Lander,Y,Y,Y,N',
    ]);
    expect(res.body.endsWith('\r\n')).toBe(true);
  });

  it('X-Manual-Delist only lists domains delisted since the previous Afternic export', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await fixture4();
    await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    const second = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(second.headers['x-manual-delist'] ?? '').toBe('');
    expect(await db.selectFrom('export_runs').selectAll().execute()).toHaveLength(2);
  });

  it('E-3: a Min Offer < 20 row is skipped and reported in X-Export-Warnings', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    // The DB CHECK forbids min_offer < 2000, so the skip path is proven in export-rows.test.ts (E-3/LX-6);
    // here: valid rows produce no warnings.
    await listedDomain({ domain: 'ok.com' });
    const res = await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth });
    expect(res.headers['x-export-warnings'] ?? '').toBe('');
  });

  it('Review Focus 4: a display name with a comma is quoted and still parses to 11 columns', async () => {
    app = await makeApp();
    const { auth } = await issueToken('read');
    await listedDomain({ domain: 'example.com', display_name: 'Ex,ample.com' });
    const rows = parseCsvStrict((await app.inject({ method: 'GET', url: '/export/afternic.csv', headers: auth })).body);
    expect(rows[1]![0]).toBe('Ex,ample.com');
    expect(rows[1]).toHaveLength(11);
  });

  it('E-8: READ ok; no token 401', async () => {
    app = await makeApp();
    expect((await app.inject({ method: 'GET', url: '/export/afternic.csv' })).statusCode).toBe(401);
  });
});

describe('GET /export/sedo.csv', () => {
  it('E-6: template missing → 501 SEDO_TEMPLATE_MISSING, never a guessed file', async () => {
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: join(tmpdir(), 'definitely-missing-sedo.json') } });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_MISSING');
  });

  it('E-7: headers and values exactly as configured; no minimum on fixed-price rows', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sedo-'));
    const path = join(dir, 'sedo_template.json');
    writeFileSync(path, JSON.stringify({
      headers: ['Domain Name', 'Option', 'Sale', 'Price', 'Min', 'Cur', 'Action'],
      map: { domain: 'Domain Name', selling_option: 'Option', for_sale: 'Sale', price: 'Price', min_price: 'Min', currency: 'Cur', action: 'Action' },
      values: { buy_now: 'FIXED', make_offer: 'OFFER', for_sale_yes: 'yes', usd: 'USD', action_add: 'ADD' },
    }));
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: path } });
    const { auth } = await issueToken('read');
    await fixture4();
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(200);
    expect(parseCsvStrict(res.body).map((r) => r.join(','))).toEqual([
      'Domain Name,Option,Sale,Price,Min,Cur,Action',
      'austinroofrepair.com,FIXED,yes,399,,USD,ADD',
      'buzz.com,OFFER,yes,,500,USD,ADD',
      'trendname.com,FIXED,yes,4999,,USD,ADD',
    ]);
  });

  it('an invalid template file → 501 SEDO_TEMPLATE_INVALID, never a guessed file', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sedo-'));
    const path = join(dir, 'sedo_template.json');
    writeFileSync(path, '{"headers": []}');
    app = await makeApp({ env: { SEDO_TEMPLATE_PATH: path } });
    const { auth } = await issueToken('read');
    const res = await app.inject({ method: 'GET', url: '/export/sedo.csv', headers: auth });
    expect(res.statusCode).toBe(501);
    expect(res.json().error.code).toBe('SEDO_TEMPLATE_INVALID');
  });
});
```
Note: the Sedo `Domain` cell uses the lowercase domain (Sedo isn't documented to take a display name); Afternic uses `display_name`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/unit/export-rows.test.ts tests/api/export.test.ts`
Expected: FAIL (modules or routes missing).

- [ ] **Step 3: Implement**

`src/services/export.ts`:
```ts
import { readFile } from 'node:fs/promises';
import type { Kysely } from 'kysely';
import { z } from 'zod';
import type { Config } from '../config.js';
import { jerusalemDate } from '../dates.js';
import type { Database, DomainRow } from '../db/types.js';

export const AFTERNIC_HEADER = [
  'Domain', 'Buy Now Price', 'Floor Price', 'Min Offer', 'Lease to Own', 'Max Lease Period', 'Sale Lander',
  'Show Buy Now Option', 'Show Lease to Own Option', 'Show Make Offer Option', 'Hidden',
] as const;

export type ExportDomain = Pick<DomainRow, 'domain' | 'display_name' | 'listing_mode' | 'bin_cents' | 'floor_cents' | 'min_offer_cents' | 'lto_max_months'>;

/** Integer USD rounded down; flags when cents were dropped. */
function usd(cents: number | null, round: { dropped: boolean }): string {
  if (cents === null) return '';
  if (cents % 100 !== 0) round.dropped = true;
  return String(Math.floor(cents / 100));
}

export function afternicRow(d: ExportDomain): { row: { cells: string[] } | { skip: string }; warnings: string[] } {
  if (!d.listing_mode) return { row: { skip: 'NOT_LISTED' }, warnings: [] };
  const round = { dropped: false };
  const min = usd(d.min_offer_cents, round);
  if (min === '' || Number(min) < 20) return { row: { skip: 'MIN_OFFER_BELOW_20' }, warnings: [`${d.domain}:MIN_OFFER_BELOW_20`] };
  const name = d.display_name ?? d.domain;
  let cells: string[];
  if (d.listing_mode === 'bin') {
    const bin = usd(d.bin_cents, round);
    cells = [name, bin, bin, bin, 'N', '', 'Buy It Now', 'Y', 'N', 'N', 'N'];
  } else if (d.listing_mode === 'offer') {
    cells = [name, '0', usd(d.floor_cents, round), min, 'N', '', 'Custom Lander', 'N', 'N', 'Y', 'N'];
  } else {
    const lto = d.lto_max_months !== null;
    cells = [name, usd(d.bin_cents, round), usd(d.floor_cents, round), min, lto ? 'Y' : 'N', lto ? String(d.lto_max_months) : '', 'Custom Lander', 'Y', lto ? 'Y' : 'N', 'Y', 'N'];
  }
  return { row: { cells }, warnings: round.dropped ? [`${d.domain}:AFTERNIC_ROUNDS_DOWN`] : [] };
}

const SedoTemplateSchema = z.object({
  headers: z.array(z.string().min(1)).min(1),
  map: z.object({
    domain: z.string(), selling_option: z.string(), for_sale: z.string(), price: z.string(),
    min_price: z.string(), currency: z.string(), action: z.string(),
  }),
  values: z.object({ buy_now: z.string(), make_offer: z.string(), for_sale_yes: z.string(), usd: z.string(), action_add: z.string() }),
}).refine((t) => Object.values(t.map).every((h) => t.headers.includes(h)), 'every mapped header must be in headers');
export type SedoTemplate = z.infer<typeof SedoTemplateSchema>;

export class SedoTemplateInvalid extends Error {}

export async function loadSedoTemplate(path: string): Promise<SedoTemplate | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  const parsed = SedoTemplateSchema.safeParse(JSON.parse(text));
  if (!parsed.success) throw new SedoTemplateInvalid(parsed.error.issues.map((i) => i.message).join('; '));
  return parsed.data;
}

export function sedoRow(d: ExportDomain, t: SedoTemplate, hybridAs: 'buy_now' | 'make_offer'): string[] {
  const round = { dropped: false };
  const fixed = d.listing_mode === 'bin' || (d.listing_mode === 'hybrid' && hybridAs === 'buy_now');
  const fields: Record<keyof SedoTemplate['map'], string> = {
    domain: d.domain,
    selling_option: fixed ? t.values.buy_now : t.values.make_offer,
    for_sale: t.values.for_sale_yes,
    price: d.listing_mode === 'offer' ? '' : usd(d.bin_cents, round),
    min_price: fixed ? '' : usd(d.min_offer_cents, round),
    currency: t.values.usd,
    action: t.values.action_add,
  };
  const byHeader = new Map(Object.entries(t.map).map(([k, h]) => [h, fields[k as keyof typeof fields]]));
  return t.headers.map((h) => byHeader.get(h) ?? '');
}

const needsQuote = /[",\r\n]/;
export function toCsv(rows: string[][]): string {
  return rows.map((r) => r.map((c) => (needsQuote.test(c) ? `"${c.replace(/"/g, '""')}"` : c)).join(',')).join('\r\n') + '\r\n';
}

const EXPORT_COLS = ['domain', 'display_name', 'listing_mode', 'bin_cents', 'floor_cents', 'min_offer_cents', 'lto_max_months'] as const;

export class ExportService {
  constructor(private readonly deps: { db: Kysely<Database>; config: Config; now: () => number }) {}

  private async listed(): Promise<ExportDomain[]> {
    return this.deps.db.selectFrom('domains').select(EXPORT_COLS).where('status', '=', 'listed').orderBy('domain').execute();
  }

  async afternic(): Promise<{ csv: string; filename: string; delist: string[]; warnings: string[] }> {
    const { db } = this.deps;
    const rows: string[][] = [[...AFTERNIC_HEADER]];
    const warnings: string[] = [];
    const exported: string[] = [];
    for (const d of await this.listed()) {
      const r = afternicRow(d);
      warnings.push(...r.warnings);
      if ('cells' in r.row) {
        rows.push(r.row.cells);
        exported.push(d.domain);
      }
    }
    const last = await db.selectFrom('export_runs').select('at').where('marketplace', '=', 'afternic').orderBy('at', 'desc').executeTakeFirst();
    let q = db.selectFrom('domains').select('domain').where('status', 'in', ['sold', 'dropped']).where('delisted_at', 'is not', null);
    if (last) q = q.where('delisted_at', '>', last.at);
    const delist = (await q.orderBy('domain').execute()).map((r) => r.domain);
    await db.insertInto('export_runs').values({ marketplace: 'afternic', domains: exported }).execute();
    return { csv: toCsv(rows), filename: `afternic-${jerusalemDate(new Date(this.deps.now()))}.csv`, delist, warnings };
  }

  async sedo(): Promise<{ csv: string; filename: string; warnings: string[] } | null> {
    const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath);
    if (!t) return null;
    const s = await this.deps.db.selectFrom('settings').select('sedo_hybrid_as').executeTakeFirstOrThrow();
    const rows: string[][] = [t.headers];
    for (const d of await this.listed()) rows.push(sedoRow(d, t, s.sedo_hybrid_as));
    await this.deps.db.insertInto('export_runs').values({ marketplace: 'sedo', domains: rows.slice(1).map((r) => r[t.headers.indexOf(t.map.domain)]!) }).execute();
    return { csv: toCsv(rows), filename: `sedo-${jerusalemDate(new Date(this.deps.now()))}.csv`, warnings: [] };
  }
}
```
`src/api/export.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../http/errors.js';
import { SedoTemplateInvalid, type ExportService } from '../services/export.js';

export function registerExport(app: FastifyInstance, service: ExportService): void {
  app.get('/export/afternic.csv', async (_req, reply) => {
    const r = await service.afternic();
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${r.filename}"`)
      .header('x-manual-delist', r.delist.join(','))
      .header('x-export-warnings', r.warnings.join(';'))
      .send(r.csv);
  });

  app.get('/export/sedo.csv', async (_req, reply) => {
    let r;
    try {
      r = await service.sedo();
    } catch (e) {
      if (e instanceof SedoTemplateInvalid) {
        throw new AppError(501, 'SEDO_TEMPLATE_INVALID', `templates/sedo_template.json is invalid: ${e.message}`);
      }
      throw e;
    }
    if (!r) {
      throw new AppError(501, 'SEDO_TEMPLATE_MISSING',
        "Sedo's bulk-upload headers aren't public. Download Sedo's example file from your Sedo account and fill templates/sedo_template.json (see docs/specs/export-csv.md).");
    }
    return reply.header('content-type', 'text/csv; charset=utf-8').header('content-disposition', `attachment; filename="${r.filename}"`).send(r.csv);
  });
}
```
`src/app.ts`: after `registerBuy(...)`: `registerExport(app, new ExportService({ db: deps.db, config: deps.config, now: deps.now ?? Date.now }));`

The E-3 API test has a weak spot. The DB CHECK `min_offer_cents ≥ 2000` makes an exported Min Offer < 20 impossible to seed through the API, so the skip path is proven at the unit level (E-3/LX-6 in `export-rows.test.ts`). The API test only asserts that no warnings appear for valid rows. Keep both.

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: Afternic export (byte-exact header, per-mode cells, delist header) and template-driven Sedo export"
```

---

### Task 3: `POST /list/{domain}`

**Files:**
- Create: `src/services/list.ts`, `src/api/list.ts`, `tests/api/list.test.ts`
- Modify: `src/app.ts`, `tests/helpers/app.ts` (`nsLookup` passthrough; default `async () => null`)

**Interfaces:**
- Consumes: `validateListing`, `listingSettings`, `presentListing`, `isCategory` (step 3), `checkApproval`, `landerNameservers`, `sameNsSet`, `afternicRow`, `sedoRow`, `loadSedoTemplate`, `normalizeDomain`, `RegistrarError`, `NsLookup`.
- Produces:
  - `interface ListBody { mode?: string; bin?: number | null; floor?: number | null; min_offer?: number | null; lto_max_months?: number | null; category?: string | null; override?: boolean; override_reason?: string | null; lander?: string; ns?: string[] | null; display_name?: string | null; dry_run?: boolean; approval_ref?: { text?: unknown; approved_at?: unknown } | null }`
  - `class ListService { constructor(deps: { db; adapters: RegistrarAdapter[]; config: Config; nsLookup: NsLookup; now: () => number }); list(domain: string, body: ListBody, ctx: { auditId: string }): Promise<Record<string, unknown>> }`
  - `registerList(app, service): void`; `AppDeps.nsLookup?: NsLookup` (default `(d) => queryNs(d, { server: config.dnsNsServer })`)

- [ ] **Step 1: Write the failing tests**

`tests/api/list.test.ts`:
```ts
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { RegistrarError } from '../../src/registrars/types.js';
import { makeApp } from '../helpers/app.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';
import { FakeAdapter } from '../helpers/fake-adapter.js';
import { issueToken } from '../helpers/tokens.js';

let app: FastifyInstance;
afterEach(async () => app?.close());
const D = 'examplecityroofing.com';
const approval = (domain = D) => ({ text: `yes list ${domain}`, approved_at: new Date(Date.now() - 3_600_000).toISOString() });

async function setup(pb = new FakeAdapter('porkbun'), nsLookup = async () => null as string[] | null) {
  app = await makeApp({ adapters: [pb], nsLookup });
  return { auth: (await issueToken('write')).auth, pb };
}
const list = (body: object, auth: Record<string, string>, domain = D, key = randomUUID()) =>
  app.inject({ method: 'POST', url: `/list/${domain}`, headers: { ...auth, 'idempotency-key': key }, payload: body });
const history = () => db.selectFrom('listing_history').selectAll().orderBy('id').execute();
const dom = () => db.selectFrom('domains').selectAll().where('domain', '=', D).executeTakeFirstOrThrow();

describe('POST /list/{domain}', () => {
  it('L-1: default lander → registrar gets exactly the afternic pair; set compare tolerates order; DB updated', async () => {
    const { auth, pb } = await setup(new FakeAdapter('porkbun', { getNs: ['NS2.AFTERNIC.COM.', 'ns1.afternic.com'] }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'set', lander: 'afternic', ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    expect(pb.calls).toContain(`setNameservers ${D} ns1.afternic.com,ns2.afternic.com`);
    expect(await dom()).toMatchObject({ lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: null });
  });

  it('L-2: lander "dan" → 422 LANDER_RETIRED', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ lander: 'dan' }, auth)).json().error.code).toBe('LANDER_RETIRED');
  });

  it('L-3: custom with 1 NS / 5 NS / an invalid hostname → 422', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    for (const ns of [['ns1.x.com'], ['a.x.com', 'b.x.com', 'c.x.com', 'd.x.com', 'e.x.com'], ['ns1.x.com', 'bad_host!']]) {
      expect((await list({ lander: 'custom', ns }, auth)).statusCode).toBe(422);
    }
  });

  it('custom with 2 valid NS → set', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ lander: 'custom', ns: ['NS1.Example.net', 'ns2.example.net'] }, auth);
    expect(res.json()).toMatchObject({ ns_status: 'set', lander: 'custom', ns: ['ns1.example.net', 'ns2.example.net'] });
    expect(pb.calls).toContain(`setNameservers ${D} ns1.example.net,ns2.example.net`);
  });

  it('L-4: not in the portfolio (missing, or sold) → 404 NOT_IN_PORTFOLIO, no registrar call', async () => {
    const { auth, pb } = await setup();
    expect((await list({}, auth)).json().error.code).toBe('NOT_IN_PORTFOLIO');
    await insertOwnedDomain(db, { domain: D, status: 'sold' });
    expect((await list({}, auth)).statusCode).toBe(404);
    expect(pb.calls).toEqual([]);
  });

  it('L-6/L5: API_ACCESS_DISABLED → 409 with the opt-in hint; nothing saved', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun', { setNs: new RegistrarError('porkbun', 'API_ACCESS_DISABLED', 'x') }));
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatchObject({ code: 'API_ACCESS_DISABLED', message: expect.stringMatching(/Opt In All Domains/) });
    expect(await dom()).toMatchObject({ listing_mode: null, status: 'owned' });
    expect(await history()).toHaveLength(0);
  });

  it('L-7: READ token → 403', async () => {
    await setup();
    await insertOwnedDomain(db, { domain: D });
    const { auth } = await issueToken('read');
    expect((await list({}, auth)).statusCode).toBe(403);
  });

  it('L-8: idempotent replay → 1 registrar NS call', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    await list({}, auth, D, 'k-l8');
    const b = await list({}, auth, D, 'k-l8');
    expect(b.headers['idempotent-replayed']).toBe('true');
    expect(pb.calls.filter((c) => c.startsWith('setNameservers'))).toHaveLength(1);
  });

  it('L-9/LH-2: one audit row per call including refusals; a rejected change writes no history', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    await list({ mode: 'bin', bin: 650, approval_ref: approval() }, auth); // geo out of range → 422
    await list({}, auth);
    expect(await db.selectFrom('audit_log').selectAll().where('path', 'like', '/list/%').execute()).toHaveLength(2);
    expect(await history()).toHaveLength(0);
  });

  it('L-11 / Review Focus 1: registrar_api none → 200 ns_status manual with steps; 0 registrar calls; prices saved', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D, registrar: 'godaddy', registrar_api: 'none', category: 'trend' });
    const res = await list({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ns_status: 'manual', manual_steps: expect.arrayContaining([expect.stringMatching(/ns1\.afternic\.com.*ns2\.afternic\.com/)]) });
    expect(pb.calls).toEqual([]);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'hybrid', bin_cents: 199500, lander: 'afternic' });
  });

  it('LH-1: hybrid → raise BIN → offer = 3 history rows in order, each with audit_id; status listed', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    await list({ mode: 'hybrid', bin: 1995, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    await list({ mode: 'hybrid', bin: 2495, floor: 950, min_offer: 950, approval_ref: approval() }, auth);
    await list({ mode: 'offer', min_offer: 500, approval_ref: approval() }, auth);
    const h = await history();
    expect(h.map((r) => [r.source, r.mode, r.bin_cents])).toEqual([['list', 'hybrid', 199500], ['list', 'hybrid', 249500], ['list', 'offer', null]]);
    expect(h.every((r) => /^aud_/.test(r.audit_id ?? ''))).toBe(true);
    expect(await dom()).toMatchObject({ status: 'listed', listing_mode: 'offer', bin_cents: null, min_offer_cents: 50000 });
  });

  it('LH-4: dry_run → 0 history rows, no NS call, response previews the Afternic (and Sedo if configured) rows', async () => {
    const { auth, pb } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399, dry_run: true, approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ dry_run: true, valid: true, preview: { afternic: `${D},399,399,399,N,,Buy It Now,Y,N,N,N`, sedo: null } });
    expect(await history()).toHaveLength(0);
    expect(pb.calls).toEqual([]);
    expect((await dom()).listing_mode).toBeNull();
  });

  it('LG-13: a price change without approval_ref → 422 APPROVAL_REQUIRED', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399 }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
  });

  it('LG-14: NS-only re-point without approval_ref → 200', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ lander: 'afternic' }, auth)).statusCode).toBe(200);
  });

  it('an invalid approval_ref (names another domain) → 422 APPROVAL_INVALID', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399, approval_ref: approval('other.com') }, auth)).json().error.code).toBe('APPROVAL_INVALID');
  });

  it('LG-11 / Review Focus 2: trend → geo without override → 422 OVERRIDE_NEEDS_APPROVAL', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    expect((await list({ category: 'geo', mode: 'bin', bin: 399, approval_ref: approval() }, auth)).json().error.code).toBe('OVERRIDE_NEEDS_APPROVAL');
  });

  it('trend → geo WITH override + reason + approval → OK; history records override + reason', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'trend' });
    const res = await list({ category: 'geo', mode: 'bin', bin: 399, override: true, override_reason: 'really a city name', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    const [h] = await history();
    expect(h).toMatchObject({ category: 'geo', override: true, override_reason: 'really a city name' });
    expect((await dom()).category).toBe('geo');
  });

  it('L3 / Review Focus 2: a category change alone re-validates the existing listing (geo bin 399 → trend fails the high-value guard)', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo', status: 'listed', listing_mode: 'bin', bin_cents: 39900, floor_cents: 39900, min_offer_cents: 39900 });
    expect((await list({ category: 'trend', approval_ref: approval() }, auth)).json().error.code).toBe('HIGH_VALUE_LOW_BIN');
  });

  it('a category change without approval → 422 APPROVAL_REQUIRED (V9)', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, category: 'geo' });
    expect((await list({ category: 'b2b' }, auth)).json().error.code).toBe('APPROVAL_REQUIRED');
  });

  it('LG-4: geo bin 650 with override + reason + approval → 200; override recorded', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 650, override: true, override_reason: 'premium city', approval_ref: approval() }, auth);
    expect(res.statusCode).toBe(200);
    expect((await history())[0]).toMatchObject({ override: true, override_reason: 'premium city', approval_text: expect.stringContaining(D) });
  });

  it('LS-14/LG-12: unknown or settings fields → 422 (strict schema); settings unchanged', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ mode: 'bin', bin: 399, offer: true, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect((await list({ geo_bin_max: 999, approval_ref: approval() }, auth)).statusCode).toBe(422);
    expect((await db.selectFrom('settings').select('geo_bin_max_cents').executeTakeFirstOrThrow()).geo_bin_max_cents).toBe(49900);
  });

  it('prices without mode → 422 MODE_INVALID', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ bin: 399, approval_ref: approval() }, auth)).json().error.code).toBe('MODE_INVALID');
  });

  it('L4 / Review Focus 4: display_name must lowercase to the domain', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    expect((await list({ display_name: 'OtherName.com' }, auth)).json().error.code).toBe('DISPLAY_NAME_MISMATCH');
    expect((await list({ display_name: 'ExampleCityRoofing.com' }, auth)).statusCode).toBe(200);
    expect((await dom()).display_name).toBe('ExampleCityRoofing.com');
  });

  it('cents in a geo BIN are kept but warned about for Afternic', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D });
    const res = await list({ mode: 'bin', bin: 399.5, approval_ref: approval() }, auth);
    expect(res.json().warnings).toContain('AFTERNIC_ROUNDS_DOWN');
    expect((await dom()).bin_cents).toBe(39950);
  });

  it('L6: immediate public-DNS check: match → ns_public match + ns_verified_at set; no answer → pending/unknown', async () => {
    const { auth } = await setup(new FakeAdapter('porkbun'), async () => ['ns2.afternic.com', 'ns1.afternic.com']);
    await insertOwnedDomain(db, { domain: D });
    const res = await list({}, auth);
    expect(res.json().ns_public).toBe('match');
    expect((await dom()).ns_verified_at).not.toBeNull();
  });

  it('returns the manual marketplace checklist incl. the day-60 Fast Transfer date', async () => {
    const { auth } = await setup();
    await insertOwnedDomain(db, { domain: D, buy_date: '2026-10-04' });
    const res = await list({ mode: 'bin', bin: 399, approval_ref: approval() }, auth);
    expect(res.json().checklist).toEqual(expect.arrayContaining([
      expect.stringMatching(/afternic\.csv.*Update/), expect.stringMatching(/sedo\.csv/), expect.stringMatching(/2026-12-03/),
    ]));
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/list.test.ts`
Expected: FAIL (route missing).

- [ ] **Step 3: Implement**

`tests/helpers/app.ts`: add an `nsLookup?: NsLookup` option and pass `nsLookup: opts.nsLookup ?? (async () => null)` to `buildApp`. **Tests must never send UDP.**

`src/services/list.ts`:
```ts
import type { Kysely } from 'kysely';
import type { Config } from '../config.js';
import type { Category, Database, DomainRow } from '../db/types.js';
import type { NsLookup } from '../dns/ns-lookup.js';
import { AppError } from '../http/errors.js';
import { RegistrarError, type RegistrarAdapter } from '../registrars/types.js';
import { checkApproval } from './approval.js';
import { afternicRow, loadSedoTemplate, sedoRow, type ExportDomain } from './export.js';
import { landerNameservers, sameNsSet } from './lander.js';
import { isCategory, listingSettings, presentListing, validateListing, type NormalizedListing } from './listing-rules.js';

export interface ListBody {
  mode?: string; bin?: number | null; floor?: number | null; min_offer?: number | null; lto_max_months?: number | null;
  category?: string | null; override?: boolean; override_reason?: string | null;
  lander?: string; ns?: string[] | null; display_name?: string | null; dry_run?: boolean;
  approval_ref?: { text?: unknown; approved_at?: unknown } | null;
}

const HOST = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const PRICE_FIELDS = ['mode', 'bin', 'floor', 'min_offer', 'lto_max_months'] as const;

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export class ListService {
  constructor(private readonly deps: { db: Kysely<Database>; adapters: RegistrarAdapter[]; config: Config; nsLookup: NsLookup; now: () => number }) {}

  async list(domain: string, body: ListBody, ctx: { auditId: string }): Promise<Record<string, unknown>> {
    const { db } = this.deps;
    const now = new Date(this.deps.now());
    const row = await db.selectFrom('domains').selectAll().where('domain', '=', domain).executeTakeFirst();
    if (!row || (row.status !== 'owned' && row.status !== 'listed')) {
      throw new AppError(404, 'NOT_IN_PORTFOLIO', `${domain} is not an owned or listed domain`);
    }
    const settings = await db.selectFrom('settings').selectAll().executeTakeFirstOrThrow();

    // Classify (L2)
    const priceChange = PRICE_FIELDS.some((f) => body[f] !== undefined && body[f] !== null);
    const categoryChange = body.category !== undefined && body.category !== null;
    const changing = priceChange || categoryChange;

    // display name (L4)
    if (body.display_name != null && body.display_name.toLowerCase() !== domain) {
      throw new AppError(422, 'DISPLAY_NAME_MISMATCH', 'display_name must be the domain with different capitalisation only');
    }

    // Approval (V9/V10)
    let approvalValid = false;
    let approvedAt: Date | null = null;
    if (body.approval_ref) {
      const a = checkApproval(body.approval_ref, domain, now, settings.approval_max_age_hours);
      if (!a.ok) throw new AppError(422, a.code, a.reason);
      approvalValid = true;
      approvedAt = a.approvedAt;
    } else if (changing) {
      throw new AppError(422, 'APPROVAL_REQUIRED', 'Changing the mode, a price or the category needs approval_ref (Dvir\'s words)');
    }

    // Category (V9 + relabel guard)
    let category: Category | null = row.category;
    if (categoryChange) {
      if (!isCategory(body.category)) throw new AppError(422, 'CATEGORY_REQUIRED', 'Unknown category');
      const highValueToGeo = body.category === 'geo' && row.category !== null && settings.high_value_categories.includes(row.category);
      if (highValueToGeo && !(body.override && body.override_reason?.trim() && approvalValid)) {
        throw new AppError(422, 'OVERRIDE_NEEDS_APPROVAL', 'Moving a high-value name to geo is an override: needs override, a reason and approval_ref');
      }
      category = body.category;
    }

    // Listing (V1–V8); a category change alone re-validates the current listing (L3)
    let listing: NormalizedListing | null = null;
    let overrideUsed = false;
    const warnings: string[] = [];
    const lsettings = listingSettings(settings);
    if (priceChange) {
      if (body.mode === undefined || body.mode === null) throw new AppError(422, 'MODE_INVALID', 'mode is required when any price is sent');
      const r = validateListing(body, { category, settings: lsettings, override: body.override ?? false, overrideReason: body.override_reason ?? null, approvalValid });
      if (!r.ok) throw new AppError(422, r.code, r.message);
      listing = r.listing;
      overrideUsed = r.overrideUsed;
      warnings.push(...r.warnings);
    } else if (categoryChange && row.listing_mode) {
      const current = {
        mode: row.listing_mode, bin: row.bin_cents === null ? null : row.bin_cents / 100,
        floor: row.floor_cents === null ? null : row.floor_cents / 100, min_offer: row.min_offer_cents === null ? null : row.min_offer_cents / 100,
        lto_max_months: row.lto_max_months,
      };
      const r = validateListing(current, { category, settings: lsettings, override: body.override ?? false, overrideReason: body.override_reason ?? null, approvalValid });
      if (!r.ok) throw new AppError(422, r.code, r.message);
      overrideUsed = r.overrideUsed;
      warnings.push(...r.warnings);
    }

    // Lander target
    const lander = body.lander ?? settings.lander_target;
    let ns: string[];
    if (lander === 'dan') throw new AppError(422, 'LANDER_RETIRED', 'Dan.com retired 2025-06-27; use afternic');
    if (lander === 'custom') {
      const list = (body.ns ?? []).map((n) => n.trim().toLowerCase().replace(/\.$/, ''));
      if (list.length < 2 || list.length > 4 || !list.every((n) => HOST.test(n))) {
        throw new AppError(422, 'NS_INVALID', 'custom lander needs 2–4 valid nameserver hostnames');
      }
      ns = list;
    } else {
      const known = landerNameservers(lander);
      if (!known) throw new AppError(422, 'LANDER_INVALID', 'lander must be afternic, sedo or custom');
      if (body.ns) throw new AppError(422, 'NS_INVALID', 'ns is only allowed with lander "custom"');
      ns = [...known];
    }

    const effective = listing ?? (row.listing_mode ? {
      mode: row.listing_mode, binCents: row.bin_cents, floorCents: row.floor_cents, minOfferCents: row.min_offer_cents, ltoMaxMonths: row.lto_max_months,
    } : null);
    const exportDomain: ExportDomain = {
      domain, display_name: body.display_name ?? row.display_name, listing_mode: effective?.mode ?? null,
      bin_cents: effective?.binCents ?? null, floor_cents: effective?.floorCents ?? null,
      min_offer_cents: effective?.minOfferCents ?? null, lto_max_months: effective?.ltoMaxMonths ?? null,
    };
    if (listing && [listing.binCents, listing.floorCents, listing.minOfferCents].some((c) => c !== null && c % 100 !== 0)) {
      warnings.push('AFTERNIC_ROUNDS_DOWN');
    }

    // Dry run: validation + preview only
    if (body.dry_run) {
      const a = effective ? afternicRow(exportDomain) : null;
      const t = await loadSedoTemplate(this.deps.config.sedoTemplatePath).catch(() => null);
      return {
        dry_run: true, valid: true, domain, category, listing: effective ? presentListing(effective) : null, lander, ns,
        preview: {
          afternic: a && 'cells' in a.row ? a.row.cells.join(',') : null,
          sedo: t && effective ? sedoRow(exportDomain, t, settings.sedo_hybrid_as).join(',') : null,
        },
        warnings,
      };
    }

    // Nameservers (before saving; L5)
    const ns_result = await this.setNameservers(row, ns);
    let ns_public: 'match' | 'pending' | 'unknown' = 'unknown';
    const seen = await this.deps.nsLookup(domain).catch(() => null);
    if (seen) ns_public = sameNsSet(seen, ns) ? 'match' : 'pending';

    // Save + history (one transaction)
    const historyChange = priceChange || categoryChange;
    await db.transaction().execute(async (trx) => {
      const nsChanged = !row.lander_ns || !sameNsSet(row.lander_ns, ns);
      await trx.updateTable('domains').set({
        ...(listing ? {
          listing_mode: listing.mode, bin_cents: listing.binCents, floor_cents: listing.floorCents,
          min_offer_cents: listing.minOfferCents, lto_max_months: listing.ltoMaxMonths, status: 'listed' as const,
        } : {}),
        ...(categoryChange ? { category } : {}),
        ...(body.display_name != null ? { display_name: body.display_name } : {}),
        lander, lander_ns: ns, lander_set_at: now,
        ns_verified_at: ns_public === 'match' ? now : nsChanged ? null : row.ns_verified_at,
        updated_at: now,
      }).where('id', '=', row.id).execute();
      if (historyChange) {
        const h = effective;
        await trx.insertInto('listing_history').values({
          domain_id: row.id, source: 'list', category, mode: h?.mode ?? null, bin_cents: h?.binCents ?? null,
          floor_cents: h?.floorCents ?? null, min_offer_cents: h?.minOfferCents ?? null, lto_max_months: h?.ltoMaxMonths ?? null,
          lander, override: overrideUsed, override_reason: overrideUsed ? (body.override_reason ?? null) : null,
          approval_text: body.approval_ref ? String(body.approval_ref.text) : null, approval_at: approvedAt, audit_id: ctx.auditId,
        }).execute();
      }
    });

    const checklist = [
      'Add/update at Afternic: download /export/afternic.csv and upload it at afternic.com/domains/add with **Update** (never Replace)',
      'Sedo: download /export/sedo.csv and use the Sedo Bulk Uploader',
    ];
    if (row.buy_date) checklist.push(`Day 60 (${addDays(row.buy_date, 60)}): enable Afternic Fast Transfer opt-in at the registrar`);
    if (row.registrar === 'godaddy') checklist.push("GoDaddy-registered: GoDaddy's own List for Sale is an alternative to the Afternic upload");

    return {
      domain, status: listing ? 'listed' : row.status, category,
      listing: effective ? presentListing(effective) : null,
      lander, ns, ns_status: ns_result.status, ...(ns_result.steps ? { manual_steps: ns_result.steps } : {}), ns_public,
      checklist, warnings,
    };
  }

  private async setNameservers(row: DomainRow, ns: string[]): Promise<{ status: 'set' | 'mismatch' | 'manual'; steps?: string[] }> {
    const adapter = this.deps.adapters.find((a) => a.name === row.registrar);
    if (row.registrar_api === 'none' || !adapter || !adapter.capabilities.canManageNs) {
      return {
        status: 'manual',
        steps: [
          `At ${row.registrar ?? 'the registrar'}: open ${row.domain} → DNS → Nameservers → use custom nameservers → ${ns.join(', ')} (menu names may differ; follow the registrar's current UI)`,
          'The service checks public DNS daily and clears the /report warning once the nameservers match',
        ],
      };
    }
    try {
      await adapter.setNameservers(row.domain, ns);
      const got = await adapter.getNameservers(row.domain);
      return { status: sameNsSet(got, ns) ? 'set' : 'mismatch' };
    } catch (e) {
      if (e instanceof RegistrarError && e.code === 'API_ACCESS_DISABLED') {
        throw new AppError(409, 'API_ACCESS_DISABLED', 'The registrar refused: API access is off for this domain. Turn on "Opt In All Domains" at porkbun.com/account/api, then call /list again.');
      }
      throw new AppError(409, 'REGISTRAR_REJECTED', 'The registrar refused the nameserver change', {
        registrar: adapter.name, registrar_code: e instanceof RegistrarError ? e.code : 'UNKNOWN',
      });
    }
  }
}

```

`src/api/list.ts`:
```ts
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { normalizeDomain } from '../domain-name.js';
import type { ListService } from '../services/list.js';

const ListBodySchema = z.object({
  mode: z.string().nullable().optional(),
  bin: z.number().nullable().optional(),
  floor: z.number().nullable().optional(),
  min_offer: z.number().nullable().optional(),
  lto_max_months: z.number().nullable().optional(),
  category: z.string().nullable().optional(),
  override: z.boolean().optional(),
  override_reason: z.string().nullable().optional(),
  lander: z.string().optional(),
  ns: z.array(z.string()).nullable().optional(),
  display_name: z.string().nullable().optional(),
  dry_run: z.boolean().optional(),
  approval_ref: z.object({ text: z.unknown().optional(), approved_at: z.unknown().optional() }).strict().nullable().optional(),
}).strict();

export function registerList(app: FastifyInstance, service: ListService): void {
  app.post<{ Params: { domain: string } }>('/list/:domain', async (req) => {
    const domain = normalizeDomain(req.params.domain);
    const body = ListBodySchema.parse(req.body ?? {});
    return service.list(domain, { ...body, mode: body.mode ?? undefined }, { auditId: req.auditId! });
  });
}
```
`src/app.ts`: add `nsLookup?: NsLookup` to `AppDeps` with default `(d: string) => queryNs(d, { server: deps.config.dnsNsServer })`, and register:
```ts
  registerList(app, new ListService({ db: deps.db, adapters, config: deps.config, nsLookup, now: deps.now ?? Date.now }));
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit`
Expected: all PASS. If a test's expectation disagrees with list.md or listing-strategy.md, stop and report NEEDS_CONTEXT. Don't change behaviour to fit the test or the test to fit the code.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: POST /list/{domain}: V1–V10, lander NS via registrar or manual steps, history, dry-run export preview"
```

---

### Task 4: NS verification job + scheduling

**Files:**
- Create: `src/jobs/ns-verify.ts`, `tests/api/ns-verify.test.ts`
- Modify: `src/app.ts` (decorate `app.nsVerifier`), `src/main.ts` (startup + every 24 h)

**Interfaces:**
- Consumes: `NsLookup`, `sameNsSet`.
- Produces: `class NsVerifier { constructor(deps: { db; nsLookup: NsLookup; now: () => number; log? }); runOnce(): Promise<{ checked: number; verified: number; cleared: number; unknown: number; skipped: boolean }> }`; `FastifyInstance.nsVerifier`

- [ ] **Step 1: Write the failing tests**

`tests/api/ns-verify.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { NsVerifier } from '../../src/jobs/ns-verify.js';
import { insertOwnedDomain, testDb as db } from '../helpers/db.js';

const NOW = Date.parse('2026-10-06T03:00:00Z');
const v = (lookup: (d: string) => Promise<string[] | null>) => new NsVerifier({ db, nsLookup: lookup, now: () => NOW });
const row = (d: string) => db.selectFrom('domains').select(['ns_verified_at']).where('domain', '=', d).executeTakeFirstOrThrow();

describe('NsVerifier', () => {
  it('L-13: DNS shows the afternic pair → ns_verified_at set', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    expect(await v(async () => ['NS2.AFTERNIC.COM', 'ns1.afternic.com']).runOnce()).toMatchObject({ checked: 1, verified: 1 });
    expect((await row('a.com')).ns_verified_at?.getTime()).toBe(NOW);
  });

  it('mismatch clears a previous verification', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: new Date(NOW - 86_400_000) });
    expect(await v(async () => ['ns1.porkbun.com', 'ns2.porkbun.com']).runOnce()).toMatchObject({ cleared: 1 });
    expect((await row('a.com')).ns_verified_at).toBeNull();
  });

  it('lookup failure (null) changes nothing', async () => {
    const at = new Date(NOW - 86_400_000);
    await insertOwnedDomain(db, { domain: 'a.com', lander: 'afternic', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'], ns_verified_at: at });
    expect(await v(async () => null).runOnce()).toMatchObject({ unknown: 1 });
    expect((await row('a.com')).ns_verified_at?.getTime()).toBe(at.getTime());
  });

  it('skips sold/dropped domains and domains without a lander target', async () => {
    await insertOwnedDomain(db, { domain: 'sold.com', status: 'sold', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    await insertOwnedDomain(db, { domain: 'none.com' });
    expect(await v(async () => ['x']).runOnce()).toMatchObject({ checked: 0 });
  });

  it('overlapping runs: the second is skipped', async () => {
    await insertOwnedDomain(db, { domain: 'a.com', lander_ns: ['ns1.afternic.com', 'ns2.afternic.com'] });
    const job = v(async () => ['ns1.afternic.com', 'ns2.afternic.com']);
    const [a, b] = await Promise.all([job.runOnce(), job.runOnce()]);
    expect([a.skipped, b.skipped].sort()).toEqual([false, true]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/api/ns-verify.test.ts`
Expected: FAIL (module missing).

- [ ] **Step 3: Implement**

`src/jobs/ns-verify.ts`:
```ts
import type { Kysely } from 'kysely';
import type { Database } from '../db/types.js';
import type { NsLookup } from '../dns/ns-lookup.js';
import { sameNsSet } from '../services/lander.js';

/** list.md step 4: daily public-DNS check of every owned/listed domain that has a lander target. */
export class NsVerifier {
  private running = false;

  constructor(private readonly deps: { db: Kysely<Database>; nsLookup: NsLookup; now: () => number; log?: { warn(o: object, m: string): void } }) {}

  async runOnce(): Promise<{ checked: number; verified: number; cleared: number; unknown: number; skipped: boolean }> {
    const out = { checked: 0, verified: 0, cleared: 0, unknown: 0, skipped: false };
    if (this.running) return { ...out, skipped: true };
    this.running = true;
    try {
      const rows = await this.deps.db.selectFrom('domains').select(['id', 'domain', 'lander_ns', 'ns_verified_at'])
        .where('status', 'in', ['owned', 'listed']).where('lander_ns', 'is not', null).execute();
      for (const r of rows) {
        out.checked++;
        const seen = await this.deps.nsLookup(r.domain).catch(() => null);
        if (!seen) {
          out.unknown++;
          continue;
        }
        if (sameNsSet(seen, r.lander_ns!)) {
          if (!r.ns_verified_at) {
            await this.deps.db.updateTable('domains').set({ ns_verified_at: new Date(this.deps.now()) }).where('id', '=', r.id).execute();
          }
          out.verified++;
        } else {
          if (r.ns_verified_at) await this.deps.db.updateTable('domains').set({ ns_verified_at: null }).where('id', '=', r.id).execute();
          out.cleared++;
        }
      }
      return out;
    } finally {
      this.running = false;
    }
  }
}
```
L-13 asserts `ns_verified_at` equals NOW on the first verification. The code sets it only when it was null, so a domain that was already verified keeps its original timestamp. That is intended.

`src/app.ts`: `app.decorate('nsVerifier', new NsVerifier({ db: deps.db, nsLookup, now: deps.now ?? Date.now, log: app.log }));` and add `nsVerifier: NsVerifier` to the `FastifyInstance` declaration.
`src/main.ts`:
```ts
const runNsVerifier = () => app.nsVerifier.runOnce().catch((e: unknown) => app.log.error({ errMessage: (e as Error).message }, 'ns verifier failed'));
void runNsVerifier();
setInterval(runNsVerifier, 24 * 3_600_000).unref();
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run && npx tsc --noEmit && npm run build`
Expected: all PASS.

- [ ] **Step 5: Commit**
```bash
git add src/ tests/
git commit -m "feat: daily public-DNS NS verification job (L-13), startup + every 24 h"
```

---

### Task 5 (Opus, not Sonnet): Gate report + spec sync

- [ ] Full suite, typecheck and build; record the counts.
- [ ] Map spec IDs to tests: L-1–L-9, L-11, L-13, E-1–E-8, LX-1–LX-7, LH-1, LH-2, LH-4 (LH-3 from step 1), the endpoint LS/LG cases, and the step-3 validator LS/LG tests.
- [ ] Final whole-change review; fix wave if needed.
- [ ] After Dvir confirms L1–L9, update `list.md` (L2–L6), `export-csv.md` (L7, `SEDO_TEMPLATE_INVALID`), `00-architecture.md` §4 (`export_runs`, `delisted_at`) and §7 codes (`NOT_IN_PORTFOLIO`, `LANDER_RETIRED`, `LANDER_INVALID`, `NS_INVALID`, `DISPLAY_NAME_MISMATCH`, `APPROVAL_REQUIRED`, `API_ACCESS_DISABLED`, `SEDO_TEMPLATE_MISSING`, `SEDO_TEMPLATE_INVALID`).
- [ ] Report; push to `main`.

---

## Self-review notes

- **list.md coverage:**
  - Behaviour step 1 (404) → Task 3.
  - Step 2 (V1–V10) → Task 3 + step-3 validator.
  - Step 3 (dry run) → Task 3.
  - Step 4 (NS: full adapter, `none` → manual; `manage`/GoDaddy → 4b per L1; public DNS + daily job) → Tasks 1, 3, 4.
  - Step 5 (save + history + listed) → Task 3.
  - Step 6 (checklist) → Task 3.
- **export-csv.md:** Afternic → Task 2 (header, rows, delist header, warnings, CRLF, filename). Sedo → Task 2 (template, 501).
- **Deferred to 4b:** L-12 (GoDaddy NS polling), `/sold` setting `delisted_at`, the drop job, `/report` warnings ("NS not on lander", "export older than 7 days while listings changed").
