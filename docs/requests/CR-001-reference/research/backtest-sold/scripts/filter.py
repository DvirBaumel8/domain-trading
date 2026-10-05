import csv,re,sys; sys.path.insert(0,'scripts')
from seg import seg,ttype,VOC
FX={'USD':1.0,'EUR':1.10,'GBP':1.27}
rows=list(csv.DictReader(open('raw/dnw_sales.csv')))+list(csv.DictReader(open('raw/dnj_sales.csv')))
out={};rej={}
for r in rows:
    d=r['domain']; sld=d[:-4]
    if not d.endswith('.com') or re.search(r'[\d-]',sld): continue
    usd=float(r['price'])*FX.get(r['currency'],0)
    if not (300<=usd<=10000): continue
    if r['sale_date_approx']<'2022-01-01': continue
    t=seg(sld)
    if not t or not (2<=len(t)<=3) or any(VOC.get(w,0)<3.0 for w in t) or any(len(w)<3 and w not in ('ai','ev','hr','it','ny','la','my','go','up','us','tv','pc','io','vr','ar','pr','dj','iq','sf','co') for w in t): continue
    r=dict(r); r['price_usd']=round(usd); r['fx_note']='' if r['currency']=='USD' else f"converted {r['currency']}x{FX[r['currency']]} [est.]"
    r['tokens']=' '.join(t); r['word_count']=len(t); r['sld_len']=len(sld); r['type']=ttype(t)
    if d in out and out[d]['sale_date_approx']<=r['sale_date_approx']: continue
    out[d]=r
w=csv.DictWriter(open('raw/candidates.csv','w'),fieldnames=list(next(iter(out.values())).keys())); w.writeheader(); w.writerows(out.values())
import collections; print(len(out), collections.Counter(r['type'] for r in out.values()), collections.Counter(r['source'] for r in out.values()))
