# DR-002: mechanical non-geo lead verifier (stand-in for /leads/verify). Input: seller pages found by web search.
import json, re, time, urllib.request, ssl, sys
UA={"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/124 Safari/537.36","Accept":"text/html"}
ctx=ssl.create_default_context()
EMAIL=re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}")
GENERIC=re.compile(r'^(info|contact|hello|hi|office|sales|support|service|services|admin|help|team|mail|inquiries|enquiries|ask|audit|security|privacy|legal|press|media|careers|jobs|hr|billing|noreply|no-reply|webmaster|partners|consulting|kontakt)\b',re.I)
def get(u,t=15): return urllib.request.urlopen(urllib.request.Request(u,headers=UA),timeout=t,context=ctx).read(250000).decode('utf-8','ignore')
def weaker(host):
    host=host.lower()
    if host.startswith("www."): host=host[4:]
    if not host.endswith(".com"): return "non_com"
    sld=host[:-4]
    if "-" in sld: return "hyphen"
    if len(sld)>=16: return "long_sld"
    return None
cfg=json.load(open(sys.argv[1])); out={}
for dom, sellers in cfg.items():
    rows=[]
    for s in sellers:
        name,url=s["name"],s["url"]; host=re.sub(r'^https?://','',url).split('/')[0]
        base="https://"+host
        emails={}; service_hit=None
        for u in [url, base+"/contact", base+"/contact-us", base+"/about"]:
            try:
                b=get(u)
                if u==url:
                    service_hit=bool(re.search(s["service_rx"], b, re.I))
                for e in EMAIL.findall(b):
                    e=e.lower().strip('.')
                    if any(x in e for x in ["sentry","wixpress","example","domain.com","@2x",".png",".jpg",".webp","schema","yourname","email.com","company.com","protocol.xyz","client."]): continue
                    if e.split("@")[1].split(".")[-2] not in host and not s.get("allow_other_domain"): 
                        # keep only emails at the firm's own domain
                        if host.split(".")[-2] not in e.split("@")[1]: continue
                    emails.setdefault(e,u)
            except Exception as ex:
                if u==url: service_hit=f"ERR {type(ex).__name__}"
            if emails and u!=url: break
            time.sleep(0.3)
        em=[{"email":e,"source_url":src,"tier":("C" if GENERIC.match(e.split('@')[0]) else "B?(role unverified)")} for e,src in list(emails.items())[:3]]
        w=weaker(host)
        rows.append({"name":name,"url":url,"host":host,"weaker":w,"service_on_page":service_hit,"emails":em,"note":s.get("note","")})
        print(f"{dom}|{name}|{host}|weaker={w}|svc={service_hit}|{[(x['email'],x['tier']) for x in em]}",flush=True)
    out[dom]=rows
json.dump(out,open(sys.argv[2],"w"),indent=1); print("done",flush=True)
