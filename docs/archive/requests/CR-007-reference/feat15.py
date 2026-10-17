# Build features for DEV15 + TEST15 + caught slice with identical code. Prints no label-wise stats.
import json,pandas as pd,numpy as np
def L(p,k='host'):
    D={}
    for l in open(p):
        try: j=json.loads(l); D[j[k]]=j
        except: pass
    return D
A=pd.read_csv('all15.csv'); M=json.load(open('sibs15.json'))
known=json.load(open('sib_known.json'))
RS=L('rdap_sib.jsonl'); RV=L('rdap_var.jsonl')
RA={k:v for k,v in L('rdap_alt.jsonl').items() if v.get('reg') is not None}
for h,j in {**L('dns_aibiz.jsonl'),**L('dns_org.jsonl')}.items():   # .ai/.biz: RDAP rate-limited/blocked -> DNS delegation; registered with unknown date -> conservative
    if h not in RA and j.get('delegated') is not None: RA[h]=dict(host=h,reg=j['delegated'],created=None)
SS=L('site_sib.jsonl'); SL=L('site_look.jsonl')
DS=L('dns_sib.jsonl')
def sib_reg(s):   # Amendment 1: RDAP if fetched, else public-DNS delegation
    if s in known: return known[s]
    r=RS.get(s)
    if r is not None and r.get('reg') is not None: return r['reg']
    d=DS.get(s,{})
    if d.get('err')=='NoNameservers': return True
    return d.get('delegated')
inuse=lambda h,S: S.get(h,{}).get('state')=='in_use'
rows=[]
for r in A.itertuples():
    sld=r.domain[:-4]; tk=r.tokens.split(); asof=r.asof; drop=r.label!='sold'
    sibs=[x+'.com' for x in M[r.domain]]
    st=[sib_reg(s) for s in sibs]; k=[x for x in st if x is not None]
    share=round(sum(k)/len(k),3) if len(k)>=15 else np.nan
    sib_use=round(sum(inuse(s,SS) for s in sibs)/len(sibs),3) if all(s in SS for s in sibs) else np.nan
    def dated(h,R):  # 1 if created before as-of; unknown -> conservative
        j=R.get(h)
        if j is None or j.get('reg') is None: return int(drop) if True else 0
        if j['reg'] is False: return 0
        if not j.get('created'): return int(drop)
        return int(j['created']<asof)
    def dated_reg(h,R):
        j=R.get(h); return j is not None and j.get('reg') is not False
    alt=0
    for x in ('net','org','biz','ca'):
        h=f'{sld}.{x}'; j=RA.get(h)
        if j is None or j.get('reg') is None: alt|=int(drop); continue   # unknown state: conservative
        if j['reg']: alt|=dated(h,RA)
    alt_use=0
    for x in ('net','org','ai','biz','ca'):
        h=f'{sld}.{x}'
        if inuse(h,SL): alt_use|=dated(h,RA)
    last=tk[-1]; al=last[:-1] if last.endswith('s') else last+'s'
    var_use=0
    for h in ('-'.join(tk)+'.com',''.join(tk[:-1]+[al])+'.com'):
        if inuse(h,SL): var_use|=dated(h,RV)
    x_use=int(any(inuse(f'{sld}.{x}',SL) for x in ('io','co','us')))
    rows.append(dict(domain=r.domain,label=r.label,role=r.role,y=int(r.label=='sold'),price=r.price,n_words=r.n_words,type=r.type,
        known_sibs=len(k),share=share,alt=alt,alt_use=alt_use,var_use=var_use,look_use=int(alt_use or var_use),sib_use=sib_use,x_use_nodate=x_use))
F=pd.DataFrame(rows); F.to_csv('features15.csv',index=False)
print('rows',len(F),'census<15',int(F.share.isna().sum()),'sib_use missing',int(F.sib_use.isna().sum()))
