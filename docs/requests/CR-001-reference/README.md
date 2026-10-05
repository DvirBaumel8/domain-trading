# CR-001 reference scripts (NON-BINDING)

**These files are non-binding reference only.** They are the scripts listed in Appendix A of `../CR-001-selection-checks.md`, copied unchanged from Gavriel's box on 2026-10-06 (folder layout mirrors the box paths). Gavriel's workers wrote them during the practice runs DR-002 / DR-003 and the sold-names backtest to stand in for missing API functions.

- They contain known shortcuts and errors (bot-written census lists, regex tiering, no control on DR-003 SURBL, tokenization faults, use of a non-published BBB endpoint).
- **They are not a specification.** DOM is not required to follow their approach, data sources, thresholds or structure. The CR text governs.
- They are not part of the build and must not be imported by the service or its tests.
- `dry-runs/DR-002/evidence/d001-uspto.log` is the USPTO wordmark query snippet (Python code saved as a log).
- `system/tools/pricing_calc.py` is the pricing settings v2 calculator; its −20% drops are superseded by selection v9.1 C18 (step-down prices).
- Checked before adding: no API keys, tokens or other secrets. None of the listed files was skipped.
