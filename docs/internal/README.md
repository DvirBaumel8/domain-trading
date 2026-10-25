# DOM internal docs

These are **DOM's own** working documents: the binding business rules, internals, test IDs and data formats behind the service. They were inherited from the specs Gavriel and Dvir wrote before 6 Oct 2026 (then `docs/specs/`) and are now maintained by DOM only; Gavriel no longer edits them.

**The interface is `docs/contract/`.** Gavriel builds against the contract, never against these files. Where an internal doc and the code disagree, the code plus the contract is what ships; the difference is listed in `gaps.md` with a decision.

| File | What |
|---|---|
| `00-architecture.md` | Scope, components, data model, adapter interface (Porkbun, GoDaddy), auth internals, hosting, risks |
| `check.md` | `/check`: quoting, exclusions, winner, availability; CK-* |
| `buy.md` | `/buy`: checks, purchase flow, post-buy, reconciler; B-* |
| `list.md` | `/list`: landers, nameservers, DNS verification; L-* |
| `listing-strategy.md` | Categories, modes, guards V1–V12, the calculator, the drop schedule, the offers log, settings v2 and v3 (§10.13) |
| `export-csv.md` | Afternic and Sedo exports, pending/manual-delist rules, upload confirmation; E-* |
| `sold.md` | `/sold`; S-* |
| `report.md` | Reads, `import-domain`, the daily registrar check, the status lifecycle; R-*, IM-* |
| `backup.md` | Nightly export, restore, drill; BK-* |
| `cli.md` | Admin and job commands; ADM-*. **Historical for the optional `dt` CLI (CLI-*): dropped, G-13** |
| `test-plan.md` | Gates G0–G5, cross-cutting tests, LS/LG/LH/LX, PR/PR3, OF, SL, JOB |
| `selection.md` | Selection v9.1 (Dvir approved 6 Oct 2026): the rules behind CR-001 |
| `selection/` | Source READMEs for the census and NameBio data (`census-README.md`, `namebio-README.md`) |
| `code-map.md` | Where every module, file, route, table and test is (start here for any change) |
| `engine.md` | Scoring engine (CR-056): release plan, data model, endings fill and point-in-time rules; EN-* |
| `visits.md` | Visitor counter (CR-068, 5.18.0): privacy rules, scope, the forward, the token hand-off; V518-* |
| `bots-token.md` | Shared `bots` token (CR-069, 5.20.0): scope rule, the route classification table, rotation, X-Bot-Name; B520-* |
| `datasave.md` | Daily data save job (CR-071, 5.21.0): steps, sealing, retention, health rule, Dynadot TODO; DS521-* |
| `closeouts.md` | Ranked closeout and drop candidates (CR-072, 5.26.0): the eight hard filters and their order, the `scorePool` step, offline scoring, the route, CC526-* |
| `books.md` | Ledger cost rows, forward-cost plans (versioned), `GET /costs/forward`, `GET /books.csv` (CR-070, 5.25.0): rules, files, BK525-* |
| `market.md` | Market episodes, labels, sales reports, matched sets, data-quality checks (CR-075, 5.23.0): rules, files, MK523-* |
| `knowledge.md` | The knowledge base (CR-078, 5.43.0): grading, clusters, the weight formula and certainty steps, versioned append-only rows, the repo load `kbLoad`; KB543-* |
| `pickproof.md` | Pick-proof mechanics (CR-073, 5.28.0): the frozen daily pool, arms A/B1/B2/C1, the seal, T30 labels, the report; the exact draw recipe; PP528-* |
| `lookups.md` | RDAP lookup service (CR-074, 5.29.0): the shared cache, the rolling 24 h bot limit, which internal steps read or fill the cache; RL529-*, BS529-1 |
| `auctions.md` | Auction bid plans (CR-077, 5.39.0): the pre-bid check, the approved maximum bid, the result, the import rule; AB539-*; v5.44.0 safety checks (BRAND-TYPO-2, URIBL-1, Spamhaus/EUIPO SKIP, transfer check); SF544-* |
| `sources.md` | Terms log of every outside data source |
| `gaps.md` | Every gap between these docs and the code, with a decision |

Changes: a CR or BUG (`docs/requests/`) → DOM updates the code, the contract (semver + `CHANGELOG.md`), these docs and `gaps.md` in the same commit, and writes a release note (`docs/releases/`).
