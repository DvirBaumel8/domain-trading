#!/usr/bin/env python3
"""DR-003 geo leads stand-in for /leads/build+/verify. Free data: BBB API + firm sites. C15 role-inbox≤10→B."""
import json, re, time, math, urllib.request, urllib.parse, html, sys, ssl
UA={"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
ctx=ssl.create_default_context()
COORDS={
 "Tulsa":(36.1540,-95.9928),"Raleigh":(35.7796,-78.6382),"Orlando":(28.5383,-81.3792),
 "Nashville":(36.1627,-86.7816),"Tampa":(27.9506,-82.4572),"Fresno":(36.7378,-119.7871),
 "Boise":(43.6150,-116.2023),"Richmond":(37.5407,-77.4360),"Omaha":(41.2565,-95.9345),
 "Tucson":(32.2226,-110.9747),"Greensboro":(36.0726,-79.7920),"Huntsville":(34.7304,-86.5861),
 "Madison":(43.0731,-89.4012),
}
REG={
 "roofing":(r'roofing|roof',r'roof'),
 "hvac":(r'hvac|heating|air conditioning|cooling',r'hvac|heating|cooling'),
 "epoxy":(r'epoxy|concrete coating|floor coating|garage floor',r'epoxy|coating'),
 "solar":(r'solar',r'solar'),
 "pool":(r'pool',r'pool'),
 "kitchen":(r'kitchen|cabinet|remodel',r'kitchen|cabinet|remodel'),
 "foundation":(r'foundation',r'foundation'),
}
EMAIL=re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
ROLE=re.compile(r'^(info|contact|hello|office|sales|support|service|services|admin|help|team|mail|inquiries|enquiries|estimates|quote|quotes|booking|schedule|customerservice|cs)\b',re.I)
MKT=re.compile(r'^(marketing|ops|operations|manager|gm|owner|president|ceo)\b',re.I)
SIZE=re.compile(r'(\d+)\s*(?:\+\s*)?(?:employees?|people|team members|staff)',re.I)
SMALL_CLAIM=re.compile(r'\b(family[- ]owned|small business|owner[- ]operated|locally owned)\b',re.I)

def get(url,accept="application/json",timeout=20):
    h=dict(UA); h["Accept"]=accept
    return urllib.request.urlopen(urllib.request.Request(url,headers=h),timeout=timeout,context=ctx).read(300000).decode('utf-8','ignore')

def dist(a,b):
    R=3958.8; la1,lo1=map(math.radians,a); la2,lo2=map(math.radians,b)
    h=math.sin((la2-la1)/2)**2+math.cos(la1)*math.cos(la2)*math.sin((lo2-lo1)/2)**2
    return 2*R*math.asin(math.sqrt(h))

def weaker(host):
    if not host: return "no_site"
    host=host.lower()
    if host.startswith("www."): host=host[4:]
    if "bbb.org" in host: return "no_site"
    if any(x in host for x in ["facebook.","fb.com","instagram.","yelp.","nextdoor.","angi.","homeadvisor."]): return "social_only_NOT_QUALIFIED"
    if any(x in host for x in ["ueniweb","godaddysites","wixsite","sites.google","business.site","square.site","weebly","wordpress.com","squarespace.com","myshopify"]): return "free_subdomain"
    if not host.endswith(".com"): return "non_com"
    sld=host[:-4].split(".")[-1]
    if "-" in sld: return "hyphen"
    if len(sld)>=16: return "long_sld"
    return None

def estimate_size(pages_text):
    """Return (size_int_or_None, evidence, <=10 bool or None)."""
    for m in SIZE.finditer(pages_text):
        n=int(m.group(1))
        return n, m.group(0), n<=10
    # team member name count heuristic
    names=re.findall(r'(?:Meet (?:the )?Team|Our Team|Our Staff)(.{0,1200})', pages_text, re.I|re.S)
    if names:
        people=re.findall(r'\b[A-Z][a-z]+\s+[A-Z][a-z]+\b', names[0])
        if 1<=len(people)<=10:
            return len(people), f"team_names≈{len(people)}", True
        if len(people)>10:
            return len(people), f"team_names≈{len(people)}", False
    if SMALL_CLAIM.search(pages_text):
        return None, "family/owner-operated claim (size UNVERIFIED)", None
    return None, None, None

def tier(email, owner_names, size_le10):
    lp=email.split("@")[0].lower()
    if ROLE.match(lp):
        if size_le10 is True:
            return "B", "role_inbox_le10"  # C15
        if size_le10 is False:
            return "C", "role_inbox_gt10"
        return "C", "role_inbox_size_unknown"  # cannot count as B without proof
    for n in owner_names:
        for part in re.split(r'[\s.,]+', n.lower()):
            if len(part)>=3 and part in lp: return "A", "owner_name_in_local"
    if MKT.match(lp): return "B", "mkt_ops_local"
    return "B?", "personal_looking_unverified"

def main():
    city,st,q,trade,dom=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5]
    c=COORDS[city]; seen={}
    for page in range(1,6):
        url="https://www.bbb.org/api/search?"+urllib.parse.urlencode({"find_country":"USA","find_text":q,"find_loc":f"{city}, {st}","page":page,"sort":"Relevance"})
        try: d=json.loads(get(url))
        except Exception as e: print('SEARCH ERR',e,flush=True); break
        for r in d.get('results',[]): seen[r['businessId']]=r
        if page>=d.get('totalPages',1): break
        time.sleep(1.0)
    catrx,namerx=REG[trade]
    rel=[]
    for r in seen.values():
        cats=' | '.join(x['name'] for x in r.get('categories') or [])
        if not (re.search(catrx,cats,re.I) or re.search(namerx,r['businessName'],re.I)): continue
        if r.get('outOfBusinessStatus'): continue
        try: la,lo=map(float,r['location'].split(',')); dd=dist(c,(la,lo))
        except: dd=999
        if dd>30: continue
        rel.append({"name":html.unescape(re.sub('<[^>]+>','',r['businessName'])),"bbb_city":r.get('city'),"bbb_state":r.get('state'),"cats":cats,"miles":round(dd,1),"profile":"https://www.bbb.org"+r['reportUrl']})
    print(dom,"seen",len(seen),"relevant_le30mi",len(rel),flush=True)
    leads=[]
    # Cap profile crawls to keep runtime sane; prefer closer
    rel=sorted(rel, key=lambda b:b['miles'])[:50]
    for b in rel:
        try: p=get(b['profile'],"text/html")
        except Exception as e: b['err']=str(e); continue
        m=re.search(r'href="(https?://[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Visit Website',p) or re.search(r'"url"\s*:\s*"(https?://(?!www\.bbb\.org)[^"]+)"',p)
        site=m.group(1) if m else ''
        bbb_emails=[e.lower().strip('.') for e in EMAIL.findall(p) if 'bbb.org' not in e.lower()]
        host=re.sub(r'^https?://','',site).split('/')[0].lower() if site else ''
        owners=re.findall(r'(?:Owner|President|CEO|Principal|General Manager|Founder)[^<]{0,5}</[^>]+>\s*<[^>]+>([^<]{3,60})<',p)
        bm=re.findall(r'(Mr\.|Ms\.|Mrs\.)\s+([A-Z][a-zA-Z\'\-]+(?:\s+[A-Z][a-zA-Z\'\-]+)+)\s*,\s*([A-Za-z /&]+)',p)
        owners+=[f"{x[1]}" for x in bm]
        b.update({"website":site,"host":host,"weaker":weaker(host),"owners":list(dict.fromkeys(owners))[:4]})
        emails=[]; bodies=[]
        for e in bbb_emails:
            if e and '@' in e: emails.append((e, b['profile']+'#bbb'))
        if site and "bbb.org" not in host and b['weaker']!="social_only_NOT_QUALIFIED":
            for path in ["","/contact","/contact-us","/about","/about-us"]:
                try:
                    body=get(site.rstrip('/')+path,"text/html",15)
                    bodies.append(body)
                    for e in EMAIL.findall(body):
                        e=e.lower().strip('.')
                        if any(x in e for x in ["sentry","wixpress","example","domain.com","@2x",".png",".jpg","godaddy","schema","yourname","email.com","bbb.org","cloudflare"]): continue
                        emails.append((e, site.rstrip('/')+path))
                except Exception: pass
                time.sleep(0.15)
        size_n,size_ev,size_le10=estimate_size("\n".join(bodies)) if bodies else (None,None,None)
        b["size_n"]=size_n; b["size_evidence"]=size_ev; b["size_le10"]=size_le10
        # dedupe emails
        seen_e=set(); uniq=[]
        for e,src in emails:
            if e in seen_e: continue
            seen_e.add(e); uniq.append((e,src))
        b["emails"]=uniq
        if b.get("weaker")!="social_only_NOT_QUALIFIED" and uniq and b.get("weaker") is not None:
            for e,src in uniq[:3]:
                t,reason=tier(e, b["owners"], size_le10)
                leads.append({
                    "domain":dom,"firm":b["name"],"email":e,"tier":t,"tier_reason":reason,
                    "weaker_domain_reason":b["weaker"],"host":host,"website":site,
                    "source_url":src,"bbb_profile":b["profile"],"miles":b["miles"],
                    "owners":b["owners"],"size_n":size_n,"size_evidence":size_ev,"size_le10":size_le10,
                    "prospect_type":"generic_same_service","cats":b["cats"],
                })
        time.sleep(0.25)
    # qualify: A/B only for gate minima; also count all qualified
    qual=[L for L in leads if L["tier"] in ("A","B","B?")]  # B? needs human - count separately
    ab=[L for L in leads if L["tier"] in ("A","B")]
    print(dom,"leads_rows",len(leads),"qualified_AB_strict",len(ab),"with_B?",len(qual),"relevant_sampled",len(rel),flush=True)
    out={"domain":dom,"city":city,"st":st,"trade":trade,"bbb_relevant_le30":len(rel),"leads":leads,
         "counts":{"rows":len(leads),"AB":len(ab),"A":sum(1 for L in leads if L["tier"]=="A"),
                   "B":sum(1 for L in leads if L["tier"]=="B"),"Bq":sum(1 for L in leads if L["tier"]=="B?"),
                   "C":sum(1 for L in leads if L["tier"]=="C")}}
    path=f"/workspace/domain-trading/dry-runs/DR-003/evidence/leads-{dom}.json"
    json.dump(out, open(path,"w"), indent=2)
    print("WROTE", path, out["counts"], flush=True)

if __name__=="__main__":
    main()
