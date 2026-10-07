# CR-003: Dynadot registrar (check prices and buy)

**From:** Gavriel (requester, on Dvir's approval)
**Status:** APPROVED by Dvir 2026-10-07 09:24 IDT, sent to DOM
**Contract base:** v2.0.2

## 1. Business need
Today only Porkbun can check prices and buy, so `/check` and `/buy` never compare prices. Dvir wants a second registrar so the software picks the cheaper one for each name. Dynadot is the choice: on 2026-10-07 its public .com price was $10.88 first year and $10.88 renewal ($21.76 for two years), against Porkbun's $22.16. It uses a prepaid account balance, the same safety model as Porkbun.
Source: dynadot.com/domain/com and dynadot.com/domain/api, read 2026-10-07. Dvir hasn't opened the account yet.

## 2. Scope
In scope: `dynadot` becomes a full registrar for `.com` in `/check`, `/buy` (dry run and real), `/health`, and the post-buy steps that `/buy` already does for Porkbun (privacy, auto-renew off, nameservers to the lander).
Out of scope: Spaceship, NameSilo, Namecheap and Name.com; transfers; renewals; other extensions; changing which registrar wins a tie beyond the existing contract rule.
How DOM builds it is DOM's choice.

## 3. Inputs (what Dvir provides)
- A Dynadot account in USD with API access, plus a production key and secret, entered by Dvir directly in Render under the names DOM's `.env.example` already uses (`DYNADOT_API_KEY`, `DYNADOT_API_SECRET`). If DOM needs other names or settings, list them in the reply.
- If Dynadot's IP allowlist is needed: tell Dvir exactly what to enter.
- The balance stays at $0 until Dvir approves the first real buy at Dynadot (the same policy as Porkbun).

## 4. Required behaviour (outputs and rules)
1. **Health:** `GET /health` lists `dynadot` with `enabled: true` once keys are set and it's allowed, and `enabled: false` otherwise. It never shows a key, a prefix or a balance.
2. **Check:** `GET /check` asks Dynadot alongside the other enabled registrars and returns a `dynadot` entry in `quotes[]` with the same fields and exclusion reasons as Porkbun (`NOT_AVAILABLE`, `PREMIUM`, `NOT_USD`, `NO_RENEWAL_PRICE`, `ADAPTER_ERROR` with `error_code`, and so on). `two_year` follows the existing rule. The winner rules are unchanged.
3. **Agreement:** when Porkbun, Dynadot and RDAP disagree on availability, `availability` is `unknown` with no winner (the existing rule). Premium or non-standard prices are excluded, never bought.
4. **Buy:** `/buy` can use `dynadot` when it's the cheapest eligible registrar, or when it's pinned with `registrar: "dynadot"`. All existing checks run in the same order. The registrar-account check uses Dynadot's balance: 409 `REGISTRAR_FUNDS` with `details.shortfall_cents` and `details.shortfall` when the balance is too low, and `REGISTRAR_STATE_UNKNOWN` when the balance can't be read. If Dynadot has an auto-recharge or a spend limit like Porkbun's, it's handled the same way (`REGISTRAR_AUTO_TOPUP_ON`, `details.reason: "MONTHLY_SPEND_LIMIT"`).
5. **Dry run:** `dry_run: true` never registers and never charges. The 2.0.2 rule applies: errors after the gates include `would_be_blocked`, `screening_pack` and `advisories`.
6. **Post-buy:** after a real Dynadot buy, `post_buy` reports privacy, auto-renew (must end up off) and lander nameservers, with the same warning codes as Porkbun. A post-buy failure is a warning and never undoes the purchase.
7. **Unknown outcome:** if Dynadot's answer leaves the purchase state unclear, the result is 202 `PURCHASE_STATE_UNKNOWN`, and the hourly reconciler settles it against Dynadot (books it or fails it), as it does for Porkbun.
8. **Registrar reads used by jobs:** the daily ownership check (`DOMAIN_LEFT_ACCOUNT`) and the other existing jobs cover domains held at Dynadot.
9. **Allowed list:** `dynadot` is used only when it's in the allowed-registrars setting. Changing that setting stays an admin step that needs Dvir's approval, and the reply says how it's turned on.

## 5. Errors
No new public codes unless DOM needs one. Any new code goes in the code index with its HTTP status and `details`. Dynadot-specific failures appear as `ADAPTER_ERROR` / `REGISTRAR_DRY_RUN_FAILED` / `REGISTRAR_REJECTED` with `details.registrar_code`.

## 6. Acceptance tests (Gavriel runs them through the API)
| ID | Test | Pass when |
|---|---|---|
| DY-1 | `GET /health` with keys set and allowed | `dynadot` shows `enabled: true`; no key or balance appears |
| DY-2 | `GET /check` on a random free `.com` | `quotes[]` has `dynadot` and `porkbun`, both eligible, prices within $0.50 of the public prices on the day; winner is the lower `two_year` |
| DY-3 | `GET /check` on `example.com` | `taken`; the `dynadot` entry is `NOT_AVAILABLE` or has `available: false` |
| DY-4 | `GET /check` on a known Dynadot premium name | the `dynadot` entry is excluded `PREMIUM` |
| DY-5 | Dry-run `/buy` with `registrar: "dynadot"` and a $0 balance | 409 `REGISTRAR_FUNDS` with `shortfall` equal to the Dynadot first-year price, plus `would_be_blocked` / `screening_pack` / `advisories` in `details` |
| DY-6 | Dry-run `/buy` with no pin, where Dynadot is cheaper | the response names `dynadot` as the registrar it would use |
| DY-7 | Dynadot keys removed or wrong | `/health` shows `enabled: false` or the quote is `ADAPTER_ERROR`; `/check` still works with Porkbun alone |
| DY-8 | `dynadot` not in the allowed list | it's excluded `REGISTRAR_NOT_ALLOWED`; pinning it gives 409 `PINNED_REGISTRAR_INELIGIBLE` |
| DY-9 | Real buy | **not run** until Dvir approves the first Dynadot purchase; then `post_buy` shows auto-renew off, and the reconciler and daily ownership check include the name |

DOM's own automated tests against Dynadot's sandbox are welcome; please say in the release note what they cover.

## 7. Questions for DOM (please answer in the reply)
1. Which Dynadot API features and permissions does the account need, and does Dynadot require an IP allowlist for them?
2. Does Dynadot report the balance, an auto-recharge setting, or a spend limit through the API? If not, how does DOM make sure `REGISTRAR_FUNDS` / `REGISTRAR_AUTO_TOPUP_ON` stay safe?
3. Can Dynadot's sandbox be used for DOM's tests, and can Gavriel see it through the API (for example a test-only mode), so DY-9 can be checked without real money?
4. Is privacy free and on by default for .com at Dynadot, as far as the API shows?
