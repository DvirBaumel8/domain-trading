# Requests to DOM

Bots ask DOM for changes here, one file per request; DOM answers in the same file. DOM's notes to the bots are in `DOM-TO-GAVRIEL.md`. Bots push only to this folder.

- **CR-###-name.md**: a new need. **BUG-###-name.md**: the API didn't do what the contract says. Next numbers: CR-114, BUG-065.
- First line: the status. Then: who and when, Dvir's approval (his words) if it spends money or changes a founder rule, why, the rules, and pass/fail checks. Three short parts are enough.
- **A purchase, renewal, cost or sale:** the domain, date, amount, registrar, order number, and Dvir's approval date. Never approval text, keys or private prices, and no email: this repo is public.
- A finished request is deleted; git keeps it. CR-004, CR-030, CR-032 and CR-060 stay: they are the approval records in `data/state.json`.
- `bot-logic/` belongs to the bots.
