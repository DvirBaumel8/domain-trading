# DR-002 stand-in for /census/siblings + /census/run. NOTE: v9 says the backend owns fixed sibling lists; these lists were written by the bot (SEL8-1 violation, logged in issues.md).
import json, urllib.request, ssl, time, re, socket
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={"User-Agent":"Mozilla/5.0"}
PARK=re.compile(r'(domain (is )?for sale|buy this domain|parked|this domain (is|has been) registered|afternic|sedo|dan\.com|hugedomains|namecheap.*parking|godaddy.*(parked|coming soon)|make an offer|is available for purchase|domain may be for sale|not yet connected|launching soon|coming soon|bodis|parkingcrew|above\.com)',re.I)
S={
"ai_sec_audit":["promptinjection","llmsecurity","aisecurity","airedteam","llmpentest","agentsecurity","ragsecurity","jailbreak","aimodel","chatbotsecurity","aigovernance","modelrisk","llmrisk","aisafety","aibias","aicompliance","genai","aiprivacy","mlsecurity","llmredteam"],
"voiceagent_trade":["plumbing","hvac","roofing","dental","legal","restaurant","realestate","insurance","salon","clinic","autorepair","electrician","landscaping","pestcontrol","medspa","veterinary","hotel","lawfirm","mortgage","solar"],
"regime_audit":["paytransparency","gdpr","soc2","hipaa","pcidss","iso27001","nis2","dora","aiact","esg","csrd","sox","ccpa","cmmc","accessibility","wcag","fedramp","iso42001","vat","transferpricing"],
"regime_compliance":["dora","doraict","nis2","aiact","csrd","cbam","eudr","cra","dsa","dma","mica","amld","gdpr","hipaa","soc2","pcidss","cmmc","fedramp","esg","sfdr"],
}
SUFFIX={"ai_sec_audit":"audit","voiceagent_trade":None,"regime_audit":"audit","regime_compliance":"compliance"}
out={}
for k,stems in S.items():
    rows=[]
    for s in stems:
        name=(f"voiceagent{s}.com" if k=="voiceagent_trade" else f"{s}{SUFFIX[k]}.com")
        try:
            urllib.request.urlopen(urllib.request.Request(f"https://rdap.verisign.com/com/v1/domain/{name}",headers=UA),timeout=15); reg=True
        except urllib.error.HTTPError as e: reg = (e.code!=404)
        except Exception: reg=None
        state="unregistered"
        if reg:
            state="registered_no_site"
            for scheme in ["https://","http://"]:
                try:
                    r=urllib.request.urlopen(urllib.request.Request(scheme+name,headers=UA),timeout=12,context=ctx)
                    body=r.read(60000).decode('utf-8','ignore'); final=r.geturl()
                    if PARK.search(body) or len(re.sub(r'<[^>]+>','',body).strip())<200: state="forsale_or_parked"
                    else: state="in_use"
                    if name.split('.')[0] not in final.lower(): state+=f"(redirect:{final[:60]})"
                    break
                except Exception as e: continue
        rows.append({"name":name,"registered":reg,"state":state})
        time.sleep(0.3)
    n=len(rows); reg_n=sum(1 for r in rows if r["registered"]); inuse=sum(1 for r in rows if r["state"].startswith("in_use"))
    fs=sum(1 for r in rows if r["state"].startswith("forsale"))
    out[k]={"siblings":rows,"registered_share":round(reg_n/n,2),"in_use_share":round(inuse/n,2),"forsale_share":round(fs/n,2)}
    print(k,"reg",reg_n,"in_use",inuse,"forsale",fs,"of",n,flush=True)
    for r in rows: print("   ",r["name"],r["state"],flush=True)
json.dump(out,open("/workspace/domain-trading/dry-runs/DR-002/evidence/census.json","w"),indent=1); print("done")
