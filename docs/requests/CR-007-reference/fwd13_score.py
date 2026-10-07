# Freeze FWD-13 scores BEFORE the drop. LR0/V10R exactly as fitted in evalr13.py (FIT only).
import json,csv,hashlib,time,pandas as pd,numpy as np
from mini_sk import LogisticRegression, StandardScaler
d=pd.read_csv('rows.csv'); d['y']=(d.label=='sold').astype(int)
d['alt_any']=(d.alt_tld_before_n>=1).astype(float).where(d.alt_tld_before_n.notna())
d=d[d.registered_share.notna()&d.n_words.notna()&d.sld_chars.notna()]
for c,dv,sv in (('prior_history',1,0),('alt_any',1,0)):
    d[c+'_i']=d[c]; m=d[c].isna(); d.loc[m&(d.y==0),c+'_i']=dv; d.loc[m&(d.y==1),c+'_i']=sv
base=['registered_share','prior_history_i','alt_any_i','n_words','sld_chars']
fit=d[d.role=='fit']; sc=StandardScaler().fit(fit[base]); m=LogisticRegression(C=1.0).fit(sc.transform(fit[base]),fit.y)
f=pd.read_csv('fwd13.csv')
C={}
for l in open('creg13.jsonl'): j=json.loads(l); C[j['domain']]=j['registered']
W={}
for fn in ('wb13.jsonl','wb13b.jsonl'):
    for l in open(fn):
        j=json.loads(l)
        if 'err' not in j: W[j['domain']]=j
A={}
for l in open('alt13.jsonl'):
    j=json.loads(l); A.setdefault(j['host'].split('.')[0],[]).append(j)
rows=[]
for _,r in f.iterrows():
    sl=r.domain[:-4]
    sib=[x.strip()+'.com' for x in open(f'../census/bt1_{sl}@v1.csv').read().split()[1:]]
    vals=[C.get(s) for s in sib]; known=[v for v in vals if v is not None]
    share=sum(known)/len(known) if known else np.nan
    alts=A.get(sl,[]); alt_n=sum(1 for a in alts if a['status']==200); alt_unknown=sum(1 for a in alts if a['status'] not in (200,404))
    w=W.get(r.domain); prior=(int(w['n_caps']>0) if w else np.nan)
    rows.append(dict(domain=r.domain,tokens=r.tokens,n_words=r.word_count,sld_chars=r.sld_len,registered_share=share,sib_known=len(known),alt_n_net_org_co_io_us_biz=alt_n,alt_unknown=alt_unknown,prior_history=prior,wb_first=(w or {}).get('first',''),wb_n_caps=(w or {}).get('n_caps','')))
o=pd.DataFrame(rows); o['alt_any']=(o.alt_n_net_org_co_io_us_biz>=1).astype(int)
def lr(pr): 
    X=o[['registered_share']].assign(p=pr,a=o.alt_any,w=o.n_words,c=o.sld_chars).values
    return m.predict_proba(sc.transform(X))[:,1]
o['LR0_if_prior0']=lr(0); o['LR0_if_prior1']=lr(1)
o['LR0']=np.where(o.prior_history.isna(),np.nan,np.where(o.prior_history==1,o.LR0_if_prior1,o.LR0_if_prior0))
def v10(pr): return (((o.registered_share>=.5)&(pr==1))|(o.alt_any==1)|((o.registered_share>=.6)&(o.n_words<=2))).astype(int)
o['v10_if_prior0']=v10(0); o['v10_if_prior1']=v10(1)
o['v10']=np.where(o.prior_history.isna(),np.where(o.v10_if_prior0==o.v10_if_prior1,o.v10_if_prior0,np.nan),np.where(o.prior_history==1,o.v10_if_prior1,o.v10_if_prior0))
o['V10R']=o.v10+0.5*o.registered_share-0.001*o.sld_chars
o['frozen_at']=time.strftime('%Y-%m-%dT%H:%M:%S%z'); o['as_of']='2026-10-06 (before drop)'
o.to_csv('fwd13_scored.csv',index=False)
meta=dict(script_sha256=hashlib.sha256(open(__file__,'rb').read()).hexdigest(),coef=dict(zip(base,m.coef_[0].round(4).tolist())),intercept=round(float(m.intercept_),4),scaler_mean=sc.m.round(4).tolist(),scaler_sd=sc.s.round(4).tolist(),frozen_at=o.frozen_at[0],n=len(o),prior_known=int(o.prior_history.notna().sum()))
json.dump(meta,open('fwd13_frozen_meta.json','w'),indent=1)
print(meta); print(o[['registered_share','alt_any','prior_history','v10','LR0']].describe().round(3).to_string())
print('v10 accept',o.v10.value_counts(dropna=False).to_dict())
