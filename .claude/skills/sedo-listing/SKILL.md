---
name: sedo-listing
description: Lists the company's domains on Sedo (Make Offer, the plan's asking price and minimum offer) through Dvir's logged-in Chrome (Claude in Chrome), because Sedo has no API we use and DOM has no Sedo template, and builds the missing Sedo bulk template from Sedo's own example file. Use it whenever a CR or Gavriel asks to list, re-price or delist names on Sedo, Dvir says "list on Sedo", `SEDO_TEMPLATE_MISSING` needs fixing, or a new name was bought and Sedo is the second listing, even if the request just says "list the new names everywhere".
---

# Sedo listing run (CR-032, CR-031 C)

Sedo is our **second** listing, after Afternic. Every Sedo listing is **Make Offer**, so Afternic holds the only binding price (`docs/contract/formats.md`, Sedo section). There's no Sedo template yet: `GET /export/sedo.csv` answers 501 `SEDO_TEMPLATE_MISSING`. So names are listed by hand, in Dvir's Chrome.

**Status: not yet run end to end.** The first real run must record what the pages actually look like, in "Known facts" below, the way `afternic-listing` does. Treat the steps marked *(verify)* as unconfirmed.

## Before you touch the site

1. **Get the plan from the repo.** For each name, read the listing plan (mode, BIN, min offer) from the CR, from Gavriel's note, or from the Afternic export in `docs/requests/exports/`.
   - **What goes to Sedo** (`formats.md`): a `hybrid` name is listed as Make Offer, with price = BIN and minimum = min offer ($1,488 and $100 today). A `bin` (geo) name is Make Offer, with price and minimum both = BIN. An `offer` name is Make Offer with only the minimum.
   - The walk-away is private and never goes to Sedo.
2. **Show Dvir the exact listing and wait for his "yes" in chat, every run.** A relayed approval in the repo is not enough.
3. **Claude Code blocks price entry** as a real-world transaction unless a permission rule in its settings allows it; a chat approval isn't enough (seen on Afternic, 9 Oct 2026). If it blocks: stop, don't work around it, leave the form unsubmitted, and tell Dvir what's filled. He finishes it, or adds a permission rule for sedo.com.
4. **Never:** another price, accepting or answering offers, payouts, account settings, paid upgrades. SedoMLS Premium only if the page shows it's free *and* Dvir agreed. No deleting listings unless the run is a delist Dvir approved.

## Doing it (Claude in Chrome)

Load the chrome-browser skill and tools, then open a new tab.
- **Sign in** at `https://sedo.com`. Never type a password. If Dvir's session isn't signed in, stop and ask him to sign in.
- **Add the name** to his Sedo portfolio *(verify the menu name: "Add domains" / "List domains")*.
  - **Typing:** Afternic needed a real click into the text area before typing; expect the same here.
  - **Settings:** Make Offer, currency USD, price, minimum offer.
  - **Ownership:** Sedo may ask to verify ownership. Our names point at Afternic's nameservers, so DNS-based verification can't be added by DOM. Report it and let Dvir choose.
- **Check every field** against the plan with a screenshot **before submitting**.
- **Verify** each name shows as listed with the right values. Save a screenshot (`save_to_disk`). Close your tabs.

## Building the Sedo template (fixes SEDO_TEMPLATE_MISSING)
If Sedo offers a bulk-upload **example file**, download it (that's a file download: ask Dvir first, stating the name and source). Copy its exact header strings and option values into `templates/sedo_template.json` (shape in `formats.md`). The service never guesses headers. Then list future names through that upload.

## After the run (Gavriel operates the API, never you)
- **Receipt:** add it at the top of `docs/requests/DOM-TO-GAVRIEL.md`: per name, the status, the values shown and the screenshot path. Say what was blocked or left unfinished.
- **Gavriel's part:** he records each real listing with `POST /listings/{domain}/venue` (`venue: sedo`, `shown: {mode: make_offer, price_usd, min_offer_usd}`).
- **Committing:** commit only the paths you changed.

## Known facts (fill in on the first run)
- **Account:** (unknown yet).
- **Listed names:** none yet. The first run is for UKCBAMCompliance.com and AIEvalsConsulting.com (hybrid $1,488 / min $100), after Afternic.
