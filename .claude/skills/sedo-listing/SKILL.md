---
name: sedo-listing
description: Lists the company's domains on Sedo (Make Offer, the plan's asking price and minimum offer) through Dvir's logged-in Chrome (Claude in Chrome), because Sedo has no API we use and DOM has no Sedo template, and builds the missing Sedo bulk template from Sedo's own example file. Use it whenever a CR or Gavriel asks to list, re-price or delist names on Sedo, Dvir says "list on Sedo", `SEDO_TEMPLATE_MISSING` needs fixing, or a new name was bought and Sedo is the second listing, even if the request just says "list the new names everywhere".
---

# Sedo listing run (CR-032, CR-031 C)

Sedo is our **second** listing, after Afternic. Every Sedo listing is **Make Offer**, so Afternic holds the only binding price (`docs/contract/formats.md`, Sedo section). There's no Sedo template yet: `GET /export/sedo.csv` answers 501 `SEDO_TEMPLATE_MISSING`. So names are listed by hand, in Dvir's Chrome.

**Status: run once (9 Oct 2026), 2 names submitted.** The real flow is in "Doing it"; keep "Known facts" current.

## Before you touch the site

1. **Get the plan from the repo.** For each name, read the listing plan (mode, BIN, min offer) from the CR, from Gavriel's note, or from the Afternic export in `docs/requests/exports/`.
   - **What goes to Sedo** (`formats.md`): a `hybrid` name is listed as Make Offer, with price = BIN and minimum = min offer ($1,488 and $100 today). A `bin` (geo) name is Make Offer, with price and minimum both = BIN. An `offer` name is Make Offer with only the minimum.
   - The walk-away is private and never goes to Sedo.
2. **Show Dvir the exact listing and wait for his "yes" in chat, every run.** A relayed approval in the repo is not enough.
3. **Claude Code blocks price entry** as a real-world transaction unless a permission rule in its settings allows it; a chat approval isn't enough (seen on Afternic, 9 Oct 2026). If it blocks: stop, don't work around it, leave the form unsubmitted, and tell Dvir what's filled. He finishes it, or adds a permission rule for sedo.com.
4. **Never:** another price, accepting or answering offers, payouts, account settings, paid upgrades. SedoMLS Premium only if the page shows it's free *and* Dvir agreed. No deleting listings unless the run is a delist Dvir approved.

## Doing it (Claude in Chrome)

Load the chrome-browser skill and tools, then open a new tab.
- **Signing in:** start at `https://sedo.com`. Signed in, the header shows "MY SEDO Dvir"; signed out, it shows Login / Register. **Never sign in for him**, not even by clicking Login with his browser's saved password (that is signing in with his credentials). Ask Dvir to sign in.
- **The menu:** MY SEDO (top right) opens a menu: My Sedo, **Add Domains**, My Domains, Billing, My Account…. Use **Add Domains** (`/member/domainsignup/index.php`).
- **Step 1 (Enter Domains):**
  - **Names:** click inside the text area (by coordinates), then type the names one per line.
  - **The agreement:** the checkbox below the names accepts Sedo's Marketplace, Transfer and User Agreements, plus parking terms if DNS points at Sedo. **That is accepting terms: quote it to Dvir and wait for his explicit yes in chat** before ticking it.
  - Then **Go to Step 2**.
- **Step 2 (Price Domains):** a grid row per name with Price, Currency ($US by default), **Price Option** (Not for sale / Buy Now / Make Offer; default Buy Now), Min. Offer and Domain/Project.
  - **What to set:** Price Option = **Make Offer** (form_input on the combobox), and Price = the BIN.
  - **Min. Offer stays disabled in this grid:** set it later from My Domains, once the names are approved.
  - **Refs:** each row's refs follow the order price, currency, option, min offer, type; `find` mislabels rows, so map them with `read_page` (filter interactive).
- **Step 3 (Activate SedoMLS Premium):** it needs Buy Now listings, so for Make Offer leave it off, and **don't tick its terms**. **Finish Adding Domains** submits.
- **After submitting:** "Your domains are currently being reviewed". Sedo verifies ownership by hand, and the names appear in My Sedo afterwards. A faster self-verification is offered; it may need DNS, which DOM can't change, so it's Dvir's choice.
- **Check every field** against the plan with a zoom screenshot **before submitting**. Save a screenshot (`save_to_disk`). Close your tabs.

## Building the Sedo template (fixes SEDO_TEMPLATE_MISSING)
If Sedo offers a bulk-upload **example file**, download it (that's a file download: ask Dvir first, stating the name and source). Copy its exact header strings and option values into `templates/sedo_template.json` (shape in `formats.md`). The service never guesses headers. Then list future names through that upload.

## After the run (Gavriel operates the API, never you)
- **Receipt:** add it at the top of `docs/requests/DOM-TO-GAVRIEL.md`: per name, the status, the values shown and the screenshot path. Say what was blocked or left unfinished.
- **Gavriel's part:** he records each real listing with `POST /listings/{domain}/venue` (`venue: sedo`, `shown: {mode: make_offer, price_usd, min_offer_usd}`).
- **Committing:** commit only the paths you changed.

## Known facts (fill in on the first run)
- **Account:** Dvir has a Sedo account (the header shows "Dvir"). Sessions expire; when signed out, ask him to sign in. `/member/myaccount.php` is a 404, so start from `https://sedo.com`.
- **Price block:** expect the same price-entry block as on Afternic. Ask Dvir to switch to Manual mode before starting (see `afternic-listing`, rule 3).
- **Listed names:** 9 Oct 2026, AIEvalsConsulting.com and UKCBAMCompliance.com submitted (Make Offer, $1,488 USD), in Sedo's ownership review. **Open:** set the $100 min offer in My Domains once they appear, then tell Gavriel to record them.
