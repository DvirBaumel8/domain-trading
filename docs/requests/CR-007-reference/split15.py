# Eligibility (label definitions only) + dev/test split BEFORE any feature is computed. Seals TEST15.
import json,re,hashlib,collections,datetime as dt,pandas as pd,numpy as np
MON={m:i+1 for i,m in enumerate(['january','february','march','april','may','june','july','august','september','october','november','december'])}
def sale_date(date,week):
    p=week.split('-'); wm=MON[p[0]]; wy=int(p[2]) if len(p)>2 else 2026
    m=re.match(r'(\d{1,2})/(\d{1,2})',str(date))
    if not m: return None
    mo,da=int(m.group(1)),int(m.group(2)); y=wy-1 if mo>wm+1 else wy
    try: return dt.date(y,mo,da).isoformat()
    except: return None
R={json.loads(l)['host']:json.loads(l) for l in open('rdap_sold.jsonl')}
S=pd.read_csv('sold_pool.csv'); c=collections.Counter(); rows=[]
for r in S.itertuples():
    j=R.get(r.domain); sd=sale_date(r.date,r.week)
    if not sd: c['no_sale_date']+=1; continue
    if not j or not j.get('reg') or not j.get('created'): c['rdap_not_registered_or_err']+=1; continue
    cr=j['created']
    if cr>sd: c['created_after_sale']+=1; continue
    age=(dt.date.fromisoformat(sd)-dt.date.fromisoformat(cr)).days/30.44
    if age>36: c['age>36m']+=1; continue
    rows.append(dict(domain=r.domain,label='sold',price=r.price,sale_date=sd,asof=cr,rdap_created=cr,age_m=round(age,1),tokens=r.tokens,n_words=r.n_words,type=r.type,venue=r.venue,week=r.week))
print('sold eligibility',dict(c),len(rows))
RD={json.loads(l)['host']:json.loads(l) for l in open('rdap_drop.jsonl')}
D=pd.read_csv('drop_sample.csv'); caught=[]
for r in D.itertuples():
    j=RD[r.domain]
    row=dict(domain=r.domain,price='',sale_date='',asof='2026-10-06',rdap_created='',age_m='',tokens=r.tokens,n_words=r.n_words,type=r.type,venue='',week='')
    if j['reg'] is False: rows.append(dict(row,label='dropped'))
    elif j['reg'] and j['created']>='2026-10-06': caught.append(dict(row,label='caught',rdap_created=j['created']))
A=pd.DataFrame(rows); print(A.label.value_counts().to_dict())
rng=np.random.RandomState(15); A['role']=''
for lab,g in A.groupby('label'):
    idx=rng.permutation(g.index.values); half=len(idx)//2
    A.loc[idx[:half],'role']='dev'; A.loc[idx[half:],'role']='test'
C=pd.DataFrame(caught); C['role']='caught_report_only'
A=pd.concat([A,C],ignore_index=True); A.to_csv('all15.csv',index=False)
T=A[A.role=='test'][['domain','label','price','sale_date','asof','tokens','n_words','type']].sort_values('domain'); T.to_csv('test15.frozen.csv',index=False)
h=hashlib.sha256(open('test15.frozen.csv','rb').read()).hexdigest()
open('test15.sha256','w').write(f"{h}  test15.frozen.csv  sealed {dt.datetime.now().isoformat(timespec='seconds')}\n")
print(A.groupby(['role','label']).size().to_dict()); print('sha256',h)
