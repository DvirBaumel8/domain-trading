import json,urllib.request,urllib.parse,sys,statistics,time
kws=sys.argv[1:]
out={}
for kw in kws:
    items=[]
    for off in (0,200):
        u="https://api.apify.com/v2/store?limit=200&offset=%d&search=%s"%(off,urllib.parse.quote(kw))
        d=json.load(urllib.request.urlopen(u,timeout=60))['data']
        items+=d['items']
        if len(d['items'])<200: break
    rows=[]
    for it in items:
        s=it.get('stats',{})
        pi=it.get('currentPricingInfo') or {}
        price=None
        if pi.get('pricingModel')=='PAY_PER_EVENT':
            ev=pi.get('pricingPerEvent',{}).get('actorChargeEvents',{})
            for k,e in ev.items():
                if e.get('isPrimaryEvent'):
                    price=e.get('eventPriceUsd') or (e.get('eventTieredPricingUsd',{}).get('FREE',{}) or {}).get('tieredEventPriceUsd')
                    price=(k,price)
        else:
            price=(pi.get('pricingModel'),pi.get('pricePerUnitUsd'))
        rows.append(dict(id=it['username']+'/'+it['name'],title=it['title'],u30=s.get('totalUsers30Days',0),u90=s.get('totalUsers90Days',0),tot=s.get('totalUsers',0),rating=s.get('actorReviewRating'),reviews=s.get('actorReviewCount'),notice=it.get('notice'),price=price))
    rows.sort(key=lambda r:-r['u30'])
    out[kw]=rows
    tot30=sum(r['u30'] for r in rows)
    print(f"\n### {kw}: n={len(rows)} sum_u30={tot30} median={statistics.median([r['u30'] for r in rows]) if rows else 0}")
    for r in rows[:8]:
        print(f"  {r['u30']:>5} {r['tot']:>6} r={r['rating']}/{r['reviews']} {r['notice']} {r['id']} | {r['title'][:60]} | {r['price']}")
    time.sleep(0.3)
json.dump(out,open('survey-%d.json'%int(time.time()),'w'))
