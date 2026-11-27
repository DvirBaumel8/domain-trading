import json,urllib.request,urllib.parse,sys,time
res={}
for kw in sys.argv[1:]:
    terms=kw.split('|'); q=terms[0]; must=[t.lower() for t in terms[1:]] or [q.lower()]
    u="https://api.apify.com/v2/store?limit=200&search=%s"%urllib.parse.quote(q)
    try: items=json.load(urllib.request.urlopen(u,timeout=60))['data']['items']
    except Exception as e: print(kw,e); continue
    rows=[]
    for it in items:
        txt=(it['title']+' '+it['name']+' '+(it.get('description') or '')).lower()
        if not any(m in txt for m in must): continue
        s=it.get('stats',{}); pi=it.get('currentPricingInfo') or {}
        price=pi.get('pricingModel')
        if price=='PAY_PER_EVENT':
            for k,e in pi.get('pricingPerEvent',{}).get('actorChargeEvents',{}).items():
                if e.get('isPrimaryEvent'):
                    p=e.get('eventPriceUsd') or ((e.get('eventTieredPricingUsd') or {}).get('FREE') or {}).get('tieredEventPriceUsd')
                    price=f"{k}={p}"
        rows.append((s.get('totalUsers30Days',0),s.get('totalUsers',0),round(s.get('actorReviewRating') or 0,1),s.get('actorReviewCount'),it.get('notice'),it['username']+'/'+it['name'],it['title'][:55],price))
    rows.sort(reverse=True)
    res[kw]=rows
    print(f"\n### {kw}: n={len(rows)} sum30={sum(r[0] for r in rows)} top3share={sum(r[0] for r in rows[:3])}")
    for r in rows[:6]: print("  ",r)
    time.sleep(0.2)
json.dump(res,open('survey2-%d.json'%int(time.time()),'w'))
