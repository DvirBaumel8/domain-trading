# Marketplace research (landers, listings, commissions, payouts, notifications)

Checked 3 Oct 2026, 18:38–18:58 IDT.

| # | Fact | Source |
|---|---|---|
| M1 | **Dan.com no longer exists.** GoDaddy bought it in 2022; it merged into Afternic (sign-ups closed 12 Sep 2024; platform retired **27 Jun 2025**). Its lander, Lease to Own, Custom Checkout Link and ownership verification now live in **Afternic**. In `dt`, "dan" is not a valid lander; it maps to Afternic | https://dancom.medium.com/farewell-from-dan-com-eb8256625430 ; https://news.dan.com/240812-seller-migration-faqs |
| M2 | Afternic commission: **Basic 15%** when the domain uses GoDaddy aftermarket nameservers at the time of sale, **25%** otherwise. Boost is 20%/30%. **$15 minimum.** Using an Afternic lander "reduces your commission rate by 33%" (template text) | https://www.afternic.com/sell-domains ; https://www.godaddy.com/help/what-is-list-for-sale-27761 ; Afternic bulk template v3 |
| M3 | Afternic Fast Transfer / Premium Network: .com with BIN < $100,000; **≥60 days** at a supported registrar; **not within 30 days of expiry**; not under a 60-day lock | https://www.afternic.com/fast-transfer |
| M4 | **One lander per domain.** Nameservers are a single set. A domain can still be *listed* on Afternic and Sedo at once; only the commission changes | M2, M5 |
| M5 | Sedo commission: **10%** for a Buy Now sale of a domain parked on Sedo or using its sales lander (ns1/ns2.sedoparking.com); **15%** for Make Offer, auctions, or Buy Now **not** on Sedo nameservers; **20%** for sales through the **SedoMLS** network. .com: no minimum fee. **MLS:** partner registrars show Sedo Buy Now listings in their own search and checkout. **MLS Premium:** the registrar is the buyer of record and the transfer is fast; the seller turns it on per domain, and it only works if the registrar participates | https://sedo.com/us/what-we-offer/price-list/ ; https://sedo.com/us/what-we-offer/registrar-services/sedomls-premium-for-registrars ; https://faq-us.sedo.com/app/answers/detail/a_id/2916 |
| M6 | Payouts: Afternic offers ACH, check, eCheck, PayPal or wire **depending on location**, with fees, plus **Good as Gold** (GoDaddy wallet credit; ID check above $2,000). W-8BEN for non-US sellers. **The exact methods for an Israeli payee are UNVERIFIED**: check the payee dropdown. Sedo: seller verification, then bank payout; Israel specifics UNVERIFIED | https://www.godaddy.com/help/what-is-list-for-sale-27761 ; https://blog.afternic.com/good-as-gold/ ; https://sedo.com/us/verify-now/ |
| M7 | Afternic **Custom Checkout Link** closes negotiated deals through Afternic at a **5% fee** (2025 figure; confirm in the dashboard) | M1 Medium post |
| M8 | Notifications reach the seller by **email + dashboard**: Afternic covers new offers and negotiation (Self-Brokerage), every transaction step (Transaction Assurance), and LTO invoices. Sedo emails about offers, sales and failed listing checks. **No public Afternic seller API or webhooks.** Sedo has a SOAP API (DomainInsert, DomainStatus, and others) but no offer or sale webhooks. Escrow.com has transaction webhooks | https://blog.afternic.com/self-brokerage-updates/ ; https://blog.afternic.com/explore-transaction-assurance/ ; https://api.sedo.com/apidocs/v1/ ; https://www.escrow.com/api/docs/webhooks |

## Bulk-upload formats (for `dt export-csv`)

**Afternic.** Verified from the official template `bulk_upload_sample_v3.xlsx` (https://www.afternic.com/forms/bulk_upload_sample_v3.xlsx, linked from https://blog.afternic.com/bulk-upload-walkthrough/). A copy is in `templates/`.
- Sheet "My List of Domains", **columns in this order**:
  `Domain,Buy Now Price,Floor Price,Min Offer,Lease to Own,Max Lease Period,Sale Lander,Show Buy Now Option,Show Lease to Own Option,Show Make Offer Option,Hidden`
- Template example row:
  `BulkTestDomain.com,2000,1800,900,Y,22,Custom Lander,Y,Y,Y,N`
- Rules from the template's "Field Descriptions":
  - Prices are USD with no `$` symbol.
  - **Min Offer ≥ $20.**
  - Lease to Own is `Y`/`N`, and needs a BIN between **$495 and $5M**.
  - Max Lease Period is 2–60 months.
  - Sale Lander is one of *Request Price, Buy It Now, Custom Lander, Cashparking*.
  - The `Show …` options apply only to the Custom Lander.
  - `Hidden`: `N` means for sale through the reseller network.
  - A blank cell means "no change".
  - The CamelCase in the Domain column sets how the name is displayed.
- Upload at https://www.afternic.com/domains/add, "Upload a File", option **"Update"**. **Never "Replace"**: Replace deletes every listing not in the file.

**Sedo.** Partly verified. Sedo's Bulk Domain Uploader (My Domains → Bulk Uploader) accepts **CSV or XLS/XLSX** and offers a downloadable "Example file". The documented fields are **Domain, Selling Option, For Sale (yes/no), Price, Minimum Price, Currency (USD/EUR/GBP), Action Type** (Action Type can also delete). Source: https://sedo.com/us/about-us/news-press/newsroom/sedo-releases-new-bulk-domain-uploader/.
- With a fixed price (Buy Now), Sedo doesn't allow a Minimum Price: https://sedo.com/services/s_priceoption3.php3?language=e
- **The exact header strings and allowed values are UNVERIFIED**, because the example file is inside the logged-in account.
- **One-time step for Dvir:** download the example file and save it as `templates/sedo_example.csv` (or `.xlsx`). `dt export-csv` reads the header row from that file. It refuses to write a Sedo file until the template exists (see `docs/internal/export-csv.md`).


## Listing modes (added 3 Oct 2026, 19:26 IDT)
How Afternic and Sedo support strict Buy Now, make-offer-only and hybrid listings, with sources, the API-vs-bulk-CSV question, and the column mapping per mode: **`../specs/listing-strategy.md` §3 and §6** (facts A1–A8 and S1–S6).

Short version:
- **Afternic floor = auto-accept** by a broker, with no call to the seller.
- **No BIN** means less network exposure and no Premium / Fast Transfer reach.
- Make Offer on the Custom Lander exists (since Aug 2024).
- There is **no seller listing API**, so listings go by bulk CSV or the dashboard.
- **Sedo:** a fixed price can't have a minimum offer, but buyers may still send lower offers, which the seller can ignore. Make Offer listings can have a minimum offer (lower offers are auto-rejected). There is no floor. MLS distributes Buy Now listings only.
- The Sedo API has exact mode fields (`price`, `minprice`, `fixedprice`) but needs the account password, so it isn't used in v1.
- **Unverified:** whether Afternic accepts Min Offer = BIN (our geo "no negotiation" guard), and whether a blank cell in an Update upload clears an old value.
