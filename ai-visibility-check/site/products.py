"""The one map of Polar products: product id -> order type, whether it autoruns, manual parts.

Product ids are public identifiers, not secrets. Checkout URLs live only in site/assets/config.js
and prices only where the site already shows them.

Order types: base | maps | listings | content | bundle.
Only `base` and `bundle` may reach the paid-run path (delivery.on_paid, behind its own gate).
maps / listings / content are delivered by hand: no engine is ever called for them.
"""
import datetime

MANUAL_DELIVERY_BUSINESS_DAYS = 3        # Mon-Fri; inside the 5 business days promised in refunds.html

# What a human owes for each manual part. Keep in step with the one-line descriptions on index.html.
MANUAL_PARTS = {
    "maps": {"name": "Google Maps Visibility Check",
             "owed": ["Google Maps profile check (name, address, phone, categories, services, description)",
                      "4 posts", "map-visibility baseline once access is given"]},
    "listings": {"name": "Listings Consistency Audit",
                 "owed": ["17 directories AI assistants read: listed, wrong or missing",
                          "ordered checklist"]},
    "content": {"name": "AI Content Pack",
                "owed": ["full-site crawl", "priority table", "rewrites for 5 pages",
                         "ready-to-paste structured data"]},
}

PRODUCTS = {
    "5a9d5f7a-72a6-4ea4-8ae7-e9d4ac498fde": {"type": "base", "name": "AI Visibility Check",
                                             "autorun": True, "manual": ()},
    "5ee66135-2547-4885-81e3-f24bed392e29": {"type": "maps", "name": MANUAL_PARTS["maps"]["name"],
                                             "autorun": False, "manual": ("maps",)},
    "f6e7aa8b-3886-4280-a584-b771c47f49ab": {"type": "listings", "name": MANUAL_PARTS["listings"]["name"],
                                             "autorun": False, "manual": ("listings",)},
    "10ba0ce6-36ac-4bcf-ab98-8d15bdf22e49": {"type": "content", "name": MANUAL_PARTS["content"]["name"],
                                             "autorun": False, "manual": ("content",)},
    "46231531-e36e-4149-aa6c-2d8c59edba87": {"type": "bundle", "name": "AI Visibility Bundle",
                                             "autorun": True, "manual": ("maps", "listings", "content")},
}
AUTORUN_TYPES = frozenset(p["type"] for p in PRODUCTS.values() if p["autorun"])
TYPES = {p["type"]: p for p in PRODUCTS.values()}

# config.js key of each buy button -> order type (checked against the exact URLs in the tests)
PAY_KEYS = {"payLinkCheck": "base", "payLinkMaps": "maps", "payLinkListings": "listings",
            "payLinkContent": "content", "payLinkBundle": "bundle"}


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
