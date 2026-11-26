"""The one map of Polar products: product id -> order type, whether it autoruns, manual parts.

Product ids are public identifiers, not secrets. Checkout URLs live only in PAY_LINKS below; the served assets/config.js is generated from it.
`price_usd` (integer dollars) is the one place prices live: the Dvir-approved Polar prices. The site's
wording is checked against it in tests/test_addons.py.

Order types: base | maps | listings_check | listings | content | bundle.
Only `base` and `bundle` may reach the paid-run path (delivery.on_paid, behind its own gate).
maps / listings_check / listings / content are delivered by hand: no engine is ever called for them.
"""
import datetime, os, re, sys

MANUAL_DELIVERY_BUSINESS_DAYS = 3        # Mon-Fri; inside the 5 business days promised in refunds.html

# What a human owes for each manual part. Keep in step with the one-line descriptions on index.html.
MANUAL_PARTS = {
    "maps": {"name": "Google Maps Visibility Check",
             "owed": ["Google Maps profile check (name, address, phone, categories, services, description)",
                      "4 posts", "map-visibility baseline once access is given"]},
    "listings_check": {"name": "Listings Consistency Check",
                       "owed": ["17 directories AI assistants read: listed, wrong or missing (report)",
                                "ordered checklist"]},
    "listings": {"name": "Listings Consistency Audit",
                 "owed": ["17 directories AI assistants read: listed, wrong or missing (report)",
                          "ordered checklist",
                          "ready-to-paste corrected-listing pack: fixed name, address, phone, hours and "
                          "description texts per directory, plus a step list"]},
    "content": {"name": "AI Content Pack",
                "owed": ["full-site crawl", "priority table", "rewrites for 5 pages",
                         "ready-to-paste structured data"]},
}

PRODUCTS = {
    "5a9d5f7a-72a6-4ea4-8ae7-e9d4ac498fde": {"type": "base", "name": "AI Visibility Check",
                                             "price_usd": 149, "autorun": True, "manual": ()},
    "5ee66135-2547-4885-81e3-f24bed392e29": {"type": "maps", "name": MANUAL_PARTS["maps"]["name"],
                                             "price_usd": 149, "autorun": False, "manual": ("maps",)},
    "f6bd53b9-59db-4f91-ac76-078ec720fa0c": {"type": "listings_check", "name": MANUAL_PARTS["listings_check"]["name"],
                                             "site_name": "Listings Consistency Check",
                                             "price_usd": 99, "autorun": False, "manual": ("listings_check",)},
    "f6e7aa8b-3886-4280-a584-b771c47f49ab": {"type": "listings", "name": MANUAL_PARTS["listings"]["name"],
                                             "site_name": "Listings with fix pack",
                                             "price_usd": 249, "autorun": False, "manual": ("listings",)},
    "10ba0ce6-36ac-4bcf-ab98-8d15bdf22e49": {"type": "content", "name": MANUAL_PARTS["content"]["name"],
                                             "price_usd": 249, "autorun": False, "manual": ("content",)},
    "46231531-e36e-4149-aa6c-2d8c59edba87": {"type": "bundle", "name": "AI Visibility Bundle",
                                             "price_usd": 397, "autorun": True, "manual": ("maps", "listings", "content")},
}
AUTORUN_TYPES = frozenset(p["type"] for p in PRODUCTS.values() if p["autorun"])
TYPES = {p["type"]: p for p in PRODUCTS.values()}

# config.js key of each buy button -> order type (checked against the exact URLs in the tests)
PAY_KEYS = {"payLinkCheck": "base", "payLinkMaps": "maps", "payLinkListingsCheck": "listings_check",
            "payLinkListings": "listings",
            "payLinkContent": "content", "payLinkBundle": "bundle"}

# The one server-side map of Polar checkout URLs (public once shown, but the add-on ones are served unless
# the ADDONS_CHECKOUT flag is exactly 'off'). The base check is always served.
PAY_LINKS = {
    "payLinkCheck": "https://buy.polar.sh/polar_cl_y4lp8S18BldD0ZyWWdevI07SSgM4eXEwJ6zOI4Fw8mv",
    "payLinkMaps": "https://buy.polar.sh/polar_cl_WLbIDFdoECel8rAZTJvC6UaexF6pSCNv9MpoY1vyfj2",
    "payLinkListingsCheck": "https://buy.polar.sh/polar_cl_DrKvZJBKUGDt4puhZpW7sRsQTINuzc7QuXYyB3Q7geb",
    "payLinkListings": "https://buy.polar.sh/polar_cl_m2zedkpR2g1l5AFs08clQMdfhGWqRr94czipg06Tuhk",
    "payLinkContent": "https://buy.polar.sh/polar_cl_7Vku9OAnFyhBOiQTJtvGUXvSTSqJyV6B69tvV2UXXtw",
    "payLinkBundle": "https://buy.polar.sh/polar_cl_oYtWtZ6fV3CZgv4QbZnQtpAlOs0Vta35Gx3zx2z7sjw",
}
ADDON_PAY_KEYS = ("payLinkMaps", "payLinkListingsCheck", "payLinkListings", "payLinkContent", "payLinkBundle")


# Agency report bundles (CR-133). Behind AIVIS_AGENCY: only the exact value '1' turns the feature on.
# N reports -> proposed list price in whole USD (not live: no Polar product ids exist and the flag is off).
AGENCY_BUNDLE_PRICES_USD = {1: 59, 5: 245, 10: 475, 25: 1075}
AGENCY_SIZES = (1, 5, 10, 25)
AGENCY_PAY_KEYS = {"payLinkAgency1": 1, "payLinkAgency5": 5, "payLinkAgency10": 10, "payLinkAgency25": 25}
_UUID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_LINK = re.compile(r"https://buy\.polar\.sh/polar_cl_[A-Za-z0-9_-]+")


def agency_on():
    """AIVIS_AGENCY, read at request time: only the exact string '1' turns the agency feature on."""
    return os.environ.get("AIVIS_AGENCY") == "1"


def agency_product_ids():
    """N -> product id, read from AIVIS_AGENCY_PRODUCT_<N> at request time. Only valid UUIDs count; an id used for an
    earlier size or equal to a PRODUCTS id is ignored for the later size and only its count is logged (never a value)."""
    out, ignored = {}, 0
    for n in AGENCY_SIZES:
        v = os.environ.get(f"AIVIS_AGENCY_PRODUCT_{n}", "").strip().lower()
        if not _UUID.fullmatch(v):
            continue
        if v in out.values() or v in {k.lower() for k in PRODUCTS}:
            ignored += 1
            continue
        out[n] = v
    if ignored:
        print(f"agency: {ignored} duplicate or clashing product setting(s) ignored", file=sys.stderr)
    return out


def agency_bundles():
    """Product id -> {type: agency_bundle, reports: N, price_usd}, only for sizes whose id is set and valid."""
    return {pid: {"type": "agency_bundle", "name": "Agency report bundle", "reports": n,
                  "price_usd": AGENCY_BUNDLE_PRICES_USD[n], "autorun": False, "manual": ()}
            for n, pid in agency_product_ids().items()}


def agency_info(product_id):
    """The bundle product for this id, or None (also None while the flag is off)."""
    if not agency_on() or not isinstance(product_id, str):
        return None
    return agency_bundles().get(product_id.strip().lower())


def agency_pay_links():
    """Bundle checkout URLs to show, from AIVIS_AGENCY_LINK_<N>: only valid ones, only with the flag on."""
    if not agency_on():
        return {}
    out = {}
    for key, n in AGENCY_PAY_KEYS.items():
        v = os.environ.get(f"AIVIS_AGENCY_LINK_{n}", "").strip()
        if _LINK.fullmatch(v):
            out[key] = v
    return out


def addons_checkout_on():
    """ADDONS_CHECKOUT, read at request time: on by default; only the exact string 'off' hides the add-on buttons."""
    return os.environ.get("ADDONS_CHECKOUT") != "off"


def visible_pay_links():
    """Checkout URLs that may appear in a served response right now (the single hook for any page or script)."""
    on = addons_checkout_on()
    return {k: u for k, u in PAY_LINKS.items() if on or k not in ADDON_PAY_KEYS}


BILLING_REASON_PURCHASE = "purchase"     # Polar's billing_reason of a one-time purchase
AMOUNT_FIELDS = ("net_amount", "total_amount", "amount")


def paid_cents(data):
    """Paid amount in cents of an order.paid payload, or None when missing or not numeric.
    Every amount field that is present must be numeric; the lowest one counts."""
    vals = []
    for k in AMOUNT_FIELDS:
        if k not in data or data[k] is None:
            continue
        v = data[k]
        if isinstance(v, bool):
            return None
        if isinstance(v, str):
            v = v.strip()
            if not re.fullmatch(r"-?\d{1,12}", v):
                return None
            v = int(v)
        elif isinstance(v, float):
            if v != v or v in (float("inf"), float("-inf")):
                return None
        elif not isinstance(v, int):
            return None
        vals.append(v)
    return min(vals) if vals else None


def check_payment(data, info):
    """-> (ok, reason). A payment may start anything only if it is a one-time purchase paid at list price or more."""
    if data.get("billing_reason") != BILLING_REASON_PURCHASE:
        return False, "billing reason is not a one-time purchase"
    cents = paid_cents(data)
    if cents is None:
        return False, "paid amount missing or not a number"
    if cents < info["price_usd"] * 100:
        return False, "paid amount is below the list price"
    return True, ""


def site_name(p):
    """The label the site shows for a product (the Polar name unless the map gives a display name)."""
    return p.get("site_name", p["name"])


def delivery_kind(order_type):
    """'auto' (paid report run), 'manual' (by hand, alert + due date) or 'auto+manual' (bundle)."""
    p = TYPES[order_type]
    return "auto+manual" if p["autorun"] and p["manual"] else "auto" if p["autorun"] else "manual"


def add_business_days(start, n=MANUAL_DELIVERY_BUSINESS_DAYS):
    """Date n business days (Mon-Fri) after `start` (a date or datetime). A weekend start counts from
    the next business day, so Fri/Sat/Sun + 3 = Wed."""
    d = start.date() if isinstance(start, datetime.datetime) else start
    while n > 0:
        d += datetime.timedelta(days=1)
        if d.weekday() < 5:
            n -= 1
    return d


def due_date(*moments):
    """ISO due date: the later of the given moments (payment, intake) + the manual-delivery days."""
    return add_business_days(max(moments)).isoformat()


def product_ids(data):
    """Every product id found in an order.paid `data` payload, in order, without repeats.
    Looks at product_id, product.id, then items[] / products[] (either as ids or objects)."""
    found = []

    def add(v):
        if isinstance(v, str) and v.strip() and v.strip() not in found:
            found.append(v.strip())

    def one(x):
        if isinstance(x, dict):
            add(x.get("product_id"))
            if isinstance(x.get("product"), dict):
                add(x["product"].get("id"))
        else:
            add(x)

    one({"product_id": data.get("product_id"), "product": data.get("product")})
    if not found:
        for key in ("items", "products"):
            for x in data.get(key) or []:
                if key == "products" and isinstance(x, dict):
                    add(x.get("id"))            # a bare product object
                one(x)
    return found
