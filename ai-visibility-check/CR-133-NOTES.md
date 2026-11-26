# CR-133 branch notes (agency report bundles)

Status: built behind `AIVIS_AGENCY` (off by default). Nothing is for sale: `AGENCY_PRODUCT_IDS` is empty, no Polar product was created, Polar was never called, the flag is not on anywhere, nothing is deployed. No PR opened.

## Final test summary (avc-tests commands, sockets disabled)
```
python -m pytest -q --disable-socket --allow-hosts=127.0.0.1,localhost ai-visibility-check/tests
349 passed, 6 subtests passed in 31.91s
python -m pytest -q --disable-socket --allow-hosts=127.0.0.1,localhost ai-visibility-check/engine/tests
83 passed in 0.84s
```
Before this change: 372 passed in total; every existing test passes unchanged (none edited). New: `tests/test_agency_bundles.py` (T-PAY, T-COUNT), `tests/test_agency_branding.py` (T-BRAND), `tests/test_agency_abuse.py` (T-ABUSE, T-REG), `engine/tests/test_agency_render.py` (render, golden file from `main`, stored result, PDF), helper `tests/agency_base.py`.

## PDF decision: real PDF, pure pip
Library **fpdf2 2.9** (wheel 0.36 MB; pulls Pillow and defusedxml and fonttools). Download sizes on Linux, Python 3.14 wheels: fpdf2 0.36 MB, Pillow 7.1 MB, fonttools 6.6 MB, defusedxml 0.03 MB, about 14 MB. Pillow is needed anyway for the logo check. No Chrome, no apt. Text is the PDF core font (Latin-1): other characters become `?`. **Not measured on Render itself** (no access); wheels are manylinux, so a plain `pip install -r requirements.txt` is expected to work on the free plan. `pypdf` (tests only) is in `requirements.txt` so the existing CI workflow installs it; **no workflow change is needed** (`ci/avc-tests.yml` untouched).

**Needs Dvir's OK:** `render.yaml`'s build command is `python3 -m compileall -q site engine`, which installs nothing. With the flag on, logo upload, PDF and SAMPLE preview need `pip install -r ai-visibility-check/requirements.txt` in the build. I did not change `render.yaml`. With the flag off the server runs without Pillow or fpdf2 (checked: imports are lazy).

## Choices and deviations to know
- Niche `roofer` in the brief is not a niche key (`roofing` is). `roofer` is accepted as an alias of `roofing` in the bundle form only.
- Existing `server.verify_polar` is now `polar_adapter.verify` (same code, same name kept). Product-id and amount parsing stay in `products.py`; the adapter calls them.
- Hooks in `delivery.py` (`GATE`, `SETTLE`, `RENDER_ARGS`) are no-ops for every order that is not a bundle run; a bundle run is an ordinary paid `base` order (own token, `/r/<token>`), so autorun, caps, retry, resume and alerts are the existing ones.
- The daily cap reserves each run's estimated cost when it starts and replaces it with the real spend when it ends. Failed runs release their slot and their reservation.
- A slot is reserved by a create-only write; taking over a voided slot is serialised by an in-process lock (one Render instance). A crash between the slot write and the order write is healed after 10 minutes by the maintenance tick (`agency.heal`).
- Portal token is 256 bits, stored hashed (`agency_tokens/<sha256>.json`); like `/r/<token>`, the record in the private store also holds it so the same claim returns the same link.
- Not built (out of scope or needs a decision): any checkout, product creation, email, monthly plans, second provider.

## Where the claim-by-email check is weaker than a checkout-id success URL
The claim asks for the Polar order id and the purchase email. Both appear on the buyer's receipt, so anyone holding the receipt (a colleague, a forwarded email) can claim; an email address is also easy to guess or already known to others. The first claim creates the link and later claims return the same link, so a leaked receipt equals a leaked bundle. Rate limits (5 claims a minute per address, 30 bad tokens a minute) slow guessing of order ids but do not remove this. A success URL that carries the checkout id would hand the link straight to the browser that paid, with a secret that is not on any receipt. **Whether Polar's checkout supports passing the checkout id to the success URL: I believe the checkout success URL accepts a `{CHECKOUT_ID}` placeholder, but I did not verify it** (no Polar call was allowed and the docs were not read in this run); confirm before relying on it.

## Spend default
`AIVIS_PACK_DAILY_CAP_USD` defaults to 60. **Dvir must confirm this before the flag is turned on.**

## Draft wording (NOT published; for Dvir to decide, wording is not mine to set as policy)
Served today: `agency-terms.html` says only that the bundle terms are published with the checkout and the general terms, refunds and privacy pages apply.

Terms (draft): "An agency report bundle holds a fixed number of reports. A report is used when its run starts for a client. If a run fails and we cannot deliver the report, it is returned to the bundle. Bundles are for one agency and cannot be moved to another purchase email. Reports are generated from AI answers that vary from run to run; no ranking or result is promised. You are responsible for the name, logo and contact line you put on a report and for having the right to use them."

Refund (draft): "If a bundle is refunded, reports not yet started are cancelled and the bundle is closed. Reports already started or delivered stay available."

Privacy (draft): "For agency bundles we keep the purchase email only as a hash, the brand settings and logo you provide (the logo is re-encoded and kept in the private store), the client business names and cities you enter, and the generated reports. We do not email anyone."
