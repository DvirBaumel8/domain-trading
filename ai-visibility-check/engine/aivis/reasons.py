"""Turn evidence into 'likely reasons' and a fix list.

Each item carries an evidence grade so we never promise what the research
does not support (Martinez 2026 survey of 45 GEO studies: no technique has a
proven stable, cross-platform causal effect on being discovered).
"""
from dataclasses import dataclass


@dataclass
class Finding:
    reason: str
    fix: str
    evidence: str      # what we observed
    grade: str         # 'strong-correlation' | 'some-evidence' | 'hygiene' | 'weak/none'
    effort: str        # 'low' | 'medium' | 'high'


def build_findings(score, niche, signals=None, target_reviews=None, competitor_reviews=None) -> list:
    f = []
    top = [c for c in score.competitors[:5]]
    if score.score < 20:
        names = ", ".join(n for n, _, _ in top[:3]) or "other businesses"
        f.append(Finding(
            "AI tools rarely name you for the questions your customers ask.",
            "Start with the sources AI reads for your trade (below); re-check monthly with the same prompts.",
            f"Named in {score.score}% of answers on average; instead they named {names}.",
            "strong-correlation", "low"))
    if target_reviews is not None and competitor_reviews:
        med = sorted(competitor_reviews)[len(competitor_reviews) // 2]
        if target_reviews < med:
            f.append(Finding(
                "Fewer Google reviews than the businesses AI names.",
                "Ask every real customer for a review (no incentives, no fake reviews; FTC rule bans them).",
                f"You have {target_reviews} reviews; named competitors' median is {med}.",
                "strong-correlation", "medium"))
    f.append(Finding(
        f"AI engines cite trade sites for {niche.plural}: " + ", ".join(niche.referees[:4]) + ".",
        "Claim and complete your profiles there; same name, address, phone and hours everywhere.",
        "Referee sites per trade from AI Syndicate Nov 2026 (331,925 citations) and Cited Lens 2026.",
        "some-evidence", "medium"))
    if signals is not None and signals.fetched:
        if signals.blocked_bots:
            f.append(Finding(
                "Your robots.txt blocks AI crawlers: " + ", ".join(signals.blocked_bots) + ".",
                "Allow OAI-SearchBot/ChatGPT-User/PerplexityBot (search bots) unless you have a reason not to.",
                "Sites blocking GPTBot were named 6.3% vs 15.2% (Cited Lens, 2,926 businesses).",
                "some-evidence", "low"))
        if not signals.has_local_schema:
            f.append(Finding(
                "No LocalBusiness-type structured data on your homepage.",
                f"Add {niche.label.title().replace(' ', '')}/LocalBusiness JSON-LD with name, address, phone, hours.",
                "Correlated (17.2% vs 11.7% named, Cited Lens) but adding schema alone moved ChatGPT citations "
                "+2.2% (not significant) in Ahrefs' 1,885-page controlled test.",
                "hygiene", "low"))
        if not signals.mentions_city:
            f.append(Finding(
                "Homepage does not clearly say which city you serve.",
                "State the city/neighborhoods and main services in plain text near the top of the page.",
                "Topical relevance is the most reproducible lever in the GEO literature (Martinez 2026).",
                "some-evidence", "low"))
    f.append(Finding(
        "Few independent mentions (local news, 'best of' lists, community sites).",
        "Earn real mentions: local press, sponsorships, association listings. No paid fake lists.",
        "Brand web mentions correlate 0.664 with AI Overview visibility vs 0.218 for backlinks (Ahrefs, 75k brands).",
        "strong-correlation", "high"))
    return f
