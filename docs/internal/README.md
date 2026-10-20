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
| `sources.md` | Terms log of every outside data source |
| `gaps.md` | Every gap between these docs and the code, with a decision |

Changes: a CR or BUG (`docs/requests/`) → DOM updates the code, the contract (semver + `CHANGELOG.md`), these docs and `gaps.md` in the same commit, and writes a release note (`docs/releases/`).
