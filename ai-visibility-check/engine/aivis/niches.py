"""Niche definitions: what customers call the service, the intents they ask
about, and the 'referee' sites AI engines cite for that trade.

Referee sites come from AI Syndicate's Nov 2026 AI Local Report (20 trades,
331,925 citations) and Cited Lens' 8-city study; see ../../sources.md.
"""
from dataclasses import dataclass, field


@dataclass(frozen=True)
class Niche:
    key: str
    label: str                 # singular, e.g. "dentist"
    plural: str                # e.g. "dentists"
    services: tuple            # specific services customers ask about
    needs: tuple               # situations / pains that trigger the search
    referees: tuple            # sites AI engines cite for this trade
    npi_taxonomy: str = ""     # NPPES taxonomy description, if a health niche
    attributes: tuple = field(default=("affordable", "highly rated", "family-friendly"))


NICHES = {
    "dentist": Niche(
        "dentist", "dentist", "dentists",
        services=("teeth cleaning", "dental implants", "Invisalign", "teeth whitening",
                  "root canal", "emergency dental care", "veneers", "crowns"),
        needs=("a chipped tooth", "tooth pain at night", "dental anxiety",
               "no dental insurance", "kids' first dental visit"),
        referees=("Google reviews", "Yelp", "Zocdoc", "Healthgrades", "DentistsRanked", "Angi"),
        npi_taxonomy="Dentist",
        attributes=("affordable", "highly rated", "gentle", "accepts new patients", "open on Saturday"),
    ),
    "cosmetic_dentist": Niche(
        "cosmetic_dentist", "cosmetic dentist", "cosmetic dentists",
        services=("porcelain veneers", "smile makeover", "teeth whitening", "dental implants", "bonding"),
        needs=("stained teeth", "a gap in my front teeth", "a wedding coming up"),
        referees=("Yelp", "ThreeBestRated", "Google reviews", "RealSelf"),
        npi_taxonomy="Dentist",
        attributes=("best reviewed", "natural-looking results", "financing available"),
    ),
    "med_spa": Niche(
        "med_spa", "med spa", "med spas",
        services=("Botox", "lip filler", "laser hair removal", "microneedling", "chemical peel",
                  "CoolSculpting", "HydraFacial"),
        needs=("fine lines", "acne scars", "a natural look", "first time Botox"),
        referees=("Yelp", "RealSelf", "The Clinic Compass", "MedSpaScout", "Google reviews", "Instagram"),
        attributes=("affordable", "highly rated", "experienced injector", "natural results"),
    ),
    "personal_injury_lawyer": Niche(
        "personal_injury_lawyer", "personal injury lawyer", "personal injury lawyers",
        services=("car accident claims", "truck accident cases", "slip and fall cases",
                  "wrongful death claims", "motorcycle accident cases"),
        needs=("a car accident that wasn't my fault", "an insurance company lowballing me",
               "a dog bite injury", "a rideshare accident"),
        referees=("Justia", "Super Lawyers", "Avvo", "Best Lawyers", "Expertise.com", "Yelp"),
        attributes=("top rated", "no win no fee", "Spanish-speaking", "free consultation"),
    ),
    "criminal_defense_lawyer": Niche(
        "criminal_defense_lawyer", "criminal defense lawyer", "criminal defense lawyers",
        services=("DUI defense", "drug charges", "assault charges", "expungement"),
        needs=("a first DUI", "a court date next week", "a warrant"),
        referees=("Justia", "Super Lawyers", "Avvo"),
        attributes=("experienced", "affordable", "former prosecutor"),
    ),
    "hvac": Niche(
        "hvac", "HVAC company", "HVAC companies",
        services=("AC repair", "furnace repair", "heat pump installation", "AC replacement",
                  "duct cleaning", "HVAC maintenance plan"),
        needs=("AC not cooling", "a furnace making noise", "high energy bills", "a new AC quote"),
        referees=("Yelp", "Angi", "Google reviews", "BBB", "Thumbtack"),
        attributes=("honest", "affordable", "24/7", "highly rated"),
    ),
    "roofing": Niche(
        "roofing", "roofer", "roofing companies",
        services=("roof replacement", "roof repair", "storm damage repair", "metal roofing",
                  "roof inspection"),
        needs=("a leaking roof", "hail damage", "an insurance roof claim", "missing shingles"),
        referees=("Yelp", "Angi", "BBB", "Google reviews"),
        attributes=("trustworthy", "affordable", "highly rated", "licensed and insured"),
    ),
    "plumber": Niche(
        "plumber", "plumber", "plumbers",
        services=("drain cleaning", "water heater replacement", "leak repair", "sewer line repair",
                  "tankless water heater installation"),
        needs=("a burst pipe", "a clogged drain", "no hot water", "a running toilet"),
        referees=("Angi", "Yelp", "Thumbtack", "Google reviews"),
        attributes=("emergency", "affordable", "honest", "24 hour"),
    ),
    "chiropractor": Niche(
        "chiropractor", "chiropractor", "chiropractors",
        services=("back pain treatment", "sports injury care", "spinal adjustment", "prenatal chiropractic"),
        needs=("lower back pain", "neck pain from work", "sciatica", "a car accident injury"),
        referees=("Yelp", "Healthgrades", "Google reviews", "Zocdoc"),
        npi_taxonomy="Chiropractor",
        attributes=("highly rated", "accepts insurance", "walk-in"),
    ),
    "veterinarian": Niche(
        "veterinarian", "vet", "veterinarians",
        services=("dog vaccinations", "cat dental cleaning", "spay and neuter", "emergency vet care"),
        needs=("a sick dog on the weekend", "a new puppy", "an older cat"),
        referees=("Yelp", "Google reviews", "Nextdoor"),
        attributes=("affordable", "gentle", "open late"),
    ),
    "garage_door": Niche(
        "garage_door", "garage door repair company", "garage door companies",
        services=("garage door spring repair", "garage door opener installation", "new garage door"),
        needs=("a garage door stuck", "a broken spring", "a noisy garage door"),
        referees=("Yelp", "Thumbtack", "Expertise.com"),
        attributes=("same day", "affordable", "honest"),
    ),
    "electrician": Niche(
        "electrician", "electrician", "electricians",
        services=("panel upgrade", "EV charger installation", "outlet repair", "whole-house rewiring"),
        needs=("lights flickering", "breaker keeps tripping", "installing an EV charger"),
        referees=("Yelp", "Angi", "Thumbtack"),
        attributes=("licensed", "affordable", "same day"),
    ),
    "real_estate_agent": Niche(
        "real_estate_agent", "real estate agent", "real estate agents",
        services=("selling a home", "first-time home buying", "luxury homes", "relocation"),
        needs=("selling my house fast", "buying my first home", "moving for a job"),
        referees=("Zillow", "Realtor.com", "HomeLight"),
        attributes=("top", "experienced", "best reviewed"),
    ),
    "orthodontist": Niche(
        "orthodontist", "orthodontist", "orthodontists",
        services=("braces for kids", "Invisalign for adults", "clear aligners"),
        needs=("crooked teeth", "an overbite", "a teen who needs braces"),
        referees=("Google reviews", "Yelp", "Healthgrades"),
        npi_taxonomy="Orthodontics and Dentofacial Orthopedics",
        attributes=("affordable", "payment plans", "highly rated"),
    ),
    "family_law_attorney": Niche(
        "family_law_attorney", "divorce lawyer", "divorce lawyers",
        services=("uncontested divorce", "child custody", "child support", "prenuptial agreements"),
        needs=("a custody dispute", "a quick uncontested divorce", "a spouse with a lawyer already"),
        referees=("Justia", "Avvo", "Super Lawyers", "Martindale"),
        attributes=("affordable", "aggressive", "flat fee"),
    ),
}


def get_niche(key: str) -> Niche:
    k = key.strip().lower().replace(" ", "_").replace("-", "_")
    if k not in NICHES:
        raise KeyError(f"unknown niche {key!r}; known: {', '.join(sorted(NICHES))}")
    return NICHES[k]
