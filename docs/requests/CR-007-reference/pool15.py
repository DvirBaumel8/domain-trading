# Build r15 candidate pools (names only; no features, no outcomes looked at).
import sys,re,csv,collections,pandas as pd
sys.path.insert(0,'scripts'); from seg import seg,ttype,VOC
EX=set(open('r15/excluded15.txt').read().split())
SHORT=('ai','ev','hr','it','ny','la','my','go','up','us','tv','pc','io','vr','ar','pr','dj','iq','sf','co')
def form(d):
    if not d.endswith('.com'): return None
    sld=d[:-4]
    if re.search(r'[^a-z]',sld) or len(sld)>25: return None
    t=seg(sld)
    if not t or not (2<=len(t)<=3) or any(VOC.get(w,0)<3.6 for w in t) or any(len(w)<3 and w not in SHORT for w in t): return None
    if ttype(t).startswith('geo'): return None
    return t
S=pd.concat([pd.read_csv('r9/us_weekly_sales_old.csv'),pd.read_csv('raw/us_weekly_sales.csv'),pd.read_csv('r15/us_sales_oct5.csv')],ignore_index=True)
S['domain']=S.domain.str.lower().str.strip()
c=collections.Counter(); rows=[]; seen=set()
for r in S.itertuples():
    d=r.domain
    if not d.endswith('.com'): continue
    c['com']+=1
    if d in seen: c['dup']+=1; continue
    seen.add(d)
    if d in EX: c['used_before']+=1; continue
    if not (r.price>=100): c['price<100']+=1; continue
    t=form(d)
    if not t: c['form']+=1; continue
    rows.append(dict(domain=d,price=r.price,date=r.date,venue=r.venue,week=r.week,tokens=' '.join(t),n_words=len(t),type=ttype(t)))
P=pd.DataFrame(rows); P.to_csv('r15/sold_pool.csv',index=False); print('SOLD',dict(c),len(P),P.n_words.value_counts().to_dict())
D=pd.read_csv('raw/sn_target_like.csv'); c=collections.Counter(); rows=[]
for r in D.itertuples():
    if not r.join_by.startswith('10/06/2026'): continue
    c['jb1006']+=1
    if r.domain in EX: c['used_before']+=1; continue
    if str(r.type).startswith('geo'): c['geo']+=1; continue
    t=form(r.domain)
    if not t: c['form']+=1; continue
    rows.append(dict(domain=r.domain,join_by=r.join_by,seller=r.seller,tokens=' '.join(t),n_words=len(t),type=ttype(t)))
P=pd.DataFrame(rows); P.to_csv('r15/drop_pool.csv',index=False); print('DROP',dict(c),len(P),P.n_words.value_counts().to_dict(),P.seller.value_counts().head(3).to_dict())
