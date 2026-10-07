# Scores TEST15 ONCE with the frozen choice15.json. Verifies the sealed file hash first. No rule edits after this.
import json, hashlib, numpy as np, pandas as pd
from common15 import *
h=hashlib.sha256(open('test15.frozen.csv','rb').read()).hexdigest(); assert h==open('test15.sha256').read().split()[0], 'sealed test file changed'
ch=json.load(open('choice15.json')); F=pd.read_csv('features15.csv')
froz=pd.read_csv('test15.frozen.csv'); assert set(froz.domain)==set(F[F.role=='test'].domain)
T=F[F.role=='test']; ex=T[T.share.isna()|T.sib_use.isna()]; T=T[T.share.notna()&T.sib_use.notna()].copy()
out=[]; P=lambda s: out.append(s) or print(s)
T['acc']=apply(ch['chosen'],ch['params'],T); T['acc_R0']=R0k(T,.5)
ka,ns,kr,nd=rates(T.acc,T.y); passed=ns>=50 and nd>=50 and ka/ns>=0.70 and kr/nd>=0.75
lo_s=wilson(ka,ns)[0]; lo_d=wilson(kr,nd)[0]; robust=passed and lo_s>=.70 and lo_d>=.75
P(f"Sealed file sha256 verified: {h}\nChosen rule (frozen {ch['frozen_at']}): {ch['chosen']} {ch['params']}\nExcluded by census filter: {len(ex)} (sold {int(ex.y.sum())}, dropped {int((1-ex.y).sum())})")
P("\n| Rule on TEST15 (sealed) | Sold accepted [Wilson 95%] | Dropped rejected [Wilson 95%] | Margin |\n|---|---|---|---|")
P(line(f"**{ch['chosen']} (chosen)**",T.acc,T)); P(line('R0 reference share≥.50 OR alt',T.acc_R0,T))
P(f"\nVERDICT: {'ROBUST PASS' if robust else ('PASS' if passed else 'FAIL')} (sold {ka}/{ns}={ka/ns:.4f} vs 0.700; dropped {kr}/{nd}={kr/nd:.4f} vs 0.750; exact fractions)")
# secondary D-14-1
S=T.copy(); S['price']=pd.to_numeric(S.price,errors='coerce'); sub=pd.concat([S[(S.y==1)&(S.price>=1000)],S[S.y==0]])
P("\nSecondary (D-14-1, report only): sold = sales ≥ $1,000")
P("| Rule | Sold ≥$1k accepted | Dropped rejected | Margin |\n|---|---|---|---|")
P(line(f"{ch['chosen']} (chosen)",sub.acc,sub)); P(line('R0 reference',sub.acc_R0,sub))
from math import comb
def mcn(a,b):
    n01=int(((a==1)&(b==0)).sum()); n10=int(((a==0)&(b==1)).sum()); n=n01+n10; k=min(n01,n10)
    return n01,n10,(min(1.0,2*sum(comb(n,i) for i in range(k+1))/2**n) if n else 1.0)
if ch['chosen']!='R0':
    for lab,yy in (('sold',1),('dropped',0)):
        s=T[T.y==yy]; a,b,p=mcn(s.acc,s.acc_R0); P(f"McNemar {lab}: chosen-only accepts {a}, R0-only accepts {b}, exact p={p:.3f}")
P("\nBy word count:")
for w,g in T.groupby('n_words'):
    ka,ns,kr,nd=rates(g.acc,g.y); P(f"- {w} words: sold {ka}/{ns} = {ka/max(ns,1):.0%}, dropped rejected {kr}/{nd} = {kr/max(nd,1):.0%}")
P("\nSold accepted by price band:")
for b,g in S[S.y==1].assign(acc=T.acc).groupby(pd.cut(S[S.y==1].price,[0,999.99,2500,1e9],labels=['<$1k','$1–2.5k','>$2.5k']),observed=False):
    P(f"- {b}: {int(g.acc.sum())}/{len(g)}")
C=F[(F.role=='caught_report_only')&F.share.notna()&F.sib_use.notna()]
P(f"\nCaught by drop-catchers on 10/06 (report only): chosen accepts {int(apply(ch['chosen'],ch['params'],C).sum())}/{len(C)}; R0 accepts {int(R0k(C,.5).sum())}/{len(C)}")
BT=set(json.load(open('../r13/brand_tokens.json'))) if True else set()
T['bigco']=T.domain.map(lambda d: any(t in d[:-4] for t in BT if len(t)>=5))
G=T[~T.bigco]; P(f"BIGCO/brand proxy hits: sold {int(T[T.y==1].bigco.sum())}, dropped {int(T[T.y==0].bigco.sum())}"); P(line('chosen after gate',G.acc,G))
T.to_csv('test15_scored.csv',index=False)
json.dump(dict(verdict='ROBUST PASS' if robust else ('PASS' if passed else 'FAIL'),sold=[ka,ns],dropped=[kr,nd]),open('test_main.json','w'))
open('test_out.md','w').write('\n'.join(out))
