# DR-002: mechanical geo lead builder (stand-in for backend /leads/build + /leads/verify). Free data only: BBB public API + firm websites.
import json, re, time, math, urllib.request, urllib.parse, html, sys, ssl
UA={"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36"}
ctx=ssl.create_default_context()
COORDS={"Pittsburgh":(40.4406,-79.9959),"Memphis":(35.1495,-90.0490),"Sacramento":(38.5816,-121.4944)}
REG={"roof":(r'roofing',r'roof'),"plumbing":(r'plumb',r'plumb'),"epoxy":(r'epoxy|concrete coating|floor coating',r'epoxy|coating')}
EMAIL=re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
GENERIC=re.compile(r'^(info|contact|hello|office|sales|support|service|services|admin|help|team|mail|inquiries|enquiries|estimates|quote|quotes|booking|schedule|customerservice|cs|jobs|careers|hr|billing|accounts|noreply|no-reply|webmaster|dispatch)\b',re.I)
MKT=re.compile(r'^(marketing|ops|operations|manager|gm|owner|president|ceo)\b',re.I)
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
def tier(email, owner_names):
    lp=email.split("@")[0].lower()
    if GENERIC.match(lp): return "C"
    for n in owner_names:
        for part in re.split(r'[\s.,]+', n.lower()):
            if len(part)>=3 and part in lp: return "A"
    if MKT.match(lp): return "B"
    # personal-looking local part (letters, maybe dot) at business domain: unknown role
    return "B?"  # needs human role check
city,st,q,trade,dom=sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5]
c=COORDS[city]; seen={}
for page in range(1,6):
    url="https://www.bbb.org/api/search?"+urllib.parse.urlencode({"find_country":"USA","find_text":q,"find_loc":f"{city}, {st}","page":page,"sort":"Relevance"})
    try: d=json.loads(get(url))
    except Exception as e: print('SEARCH ERR',e,flush=True); break
    for r in d.get('results',[]): seen[r['businessId']]=r
    if page>=d.get('totalPages',1): break
    time.sleep(1.5)
catrx,namerx=REG[trade]; rel=[]
for r in seen.values():
    cats=' | '.join(x['name'] for x in r.get('categories') or [])
    if not (re.search(catrx,cats,re.I) or re.search(namerx,r['businessName'],re.I)): continue
    if r.get('outOfBusinessStatus'): continue
    try: la,lo=map(float,r['location'].split(',')); dd=dist(c,(la,lo))
    except: dd=999
    if dd>30: continue
    rel.append({"name":html.unescape(re.sub('<[^>]+>','',r['businessName'])),"bbb_city":r.get('city'),"bbb_state":r.get('state'),"cats":cats,"miles":round(dd,1),"profile":"https://www.bbb.org"+r['reportUrl']})
print(dom,"seen",len(seen),"relevant",len(rel),flush=True)
leads=[]
for b in rel:
    try: p=get(b['profile'],"text/html")
    except Exception as e: b['err']=str(e); continue
    m=re.search(r'href="(https?://[^"]+)"[^>]*>\s*(?:<[^>]+>\s*)*Visit Website',p) or re.search(r'"url"\s*:\s*"(https?://(?!www\.bbb\.org)[^"]+)"',p)
    site=m.group(1) if m else ''
    host=re.sub(r'^https?://','',site).split('/')[0].lower() if site else ''
    owners=re.findall(r'(?:Owner|President|CEO|Principal|General Manager|Founder)[^<]{0,5}</[^>]+>\s*<[^>]+>([^<]{3,60})<',p)
    owners+= [m2 for m2 in re.findall(r'"(?:name)"\s*:\s*"([A-Z][a-z]+ [A-Z][a-z]+)"',p)][:3]
    # BBB "Business Management" block
    bm=re.findall(r'(Mr\.|Ms\.|Mrs\.)\s+([A-Z][a-zA-Z\'\-]+(?:\s+[A-Z][a-zA-Z\'\-]+)+)\s*,\s*([A-Za-z /&]+)',p)
    owners+=[f"{x[1]}" for x in bm]
    roles=[f"{x[1]} ({x[2].strip()})" for x in bm]
    b.update({"website":site,"host":host,"weaker":weaker(host),"owners":list(dict.fromkeys(owners))[:4],"roles":roles[:4]})
    emails=[]
    if site and "bbb.org" not in host and b['weaker']!="social_only_NOT_QUALIFIED":
        for path in ["","/contact","/contact-us"]:
            try:
                body=get(site.rstrip('/')+path,"text/html",15)
                for e in EMAIL.findall(body):
                    e=e.lower().strip('.')
                    if any(x in e for x in ["sentry","wixpress","example","domain.com","@2x",".png",".jpg","godaddy","schema","yourname","email.com","bbb.org"]): continue
                    emails.append((e, site.rstrip('/')+path))
            except Exception: pass
            if emails: break
            time.sleep(0.4)
    # dedupe
    seen_e={}; 
    for e,src in emails: seen_e.setdefault(e,src)
    b['emails']=[{"email":e,"source_url":s,"tier":tier(e,b['owners'])} for e,s in list(seen_e.items())[:4]]
    leads.append(b)
    print(f"{b['name'][:40]}|{host or '-'}|{b['weaker']}|{[(x['email'],x['tier']) for x in b['emails']]}|{b['roles']}",flush=True)
    time.sleep(1.0)
json.dump({"domain":dom,"city":city,"st":st,"query":q,"seen":len(seen),"relevant_30mi":len(rel),"leads":leads,
           "source":"https://www.bbb.org/search?"+urllib.parse.urlencode({"find_country":"USA","find_text":q,"find_loc":f"{city}, {st}"})},
          open(f"/workspace/domain-trading/dry-runs/DR-002/evidence/leads-{dom}.json","w"),indent=1)
print("done",flush=True)
