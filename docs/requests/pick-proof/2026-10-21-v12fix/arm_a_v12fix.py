#!/usr/bin/env python3
"""Pick-proof arm A-v12fix, day 2026-10-21 (CR-073a item 5). Script only, no LLM, no DOM picks route.
Pool: DOM frozen pool sha 80ccb7898b4d753fef8efdb5f0716ac96313d2c7d0891b3f8bc5bb8663a98e8d. K1: the SAME K1 file arm A
produced (domain-trading sourcing/pick-proof/2026-10-21-r2/k1.csv, arm_a.py sha a0e86235..., file sha checked below).
Scorer: score_v12fix.py (same frozen weights d72d3e2e). word_count imputation = 2 for every K1 name, from our own
2-word split; price-neutral rank = price removed from the scorer's inputs. Output: top 100 by v12fix_rank."""
import sys,os,hashlib,pandas as pd
H=os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0,H); import score_v12fix as S
K1='/workspace/domain-trading/sourcing/pick-proof/2026-10-21-r2/k1.csv'
K1SHA='775c5f228c1c9682daaad90bafe31e5cc8163bc79a67c8a5f236e87b7a3ddfbf'
assert hashlib.sha256(open(K1,'rb').read()).hexdigest()==K1SHA,'k1.csv sha mismatch'
k=pd.read_csv(K1); r=S.score(k.domain.tolist()).head(100)
r.to_csv(os.path.join(H,'2026-10-21-a-v12fix-ranked.csv'),index=False)
open(os.path.join(H,'2026-10-21-a-v12fix-picks.txt'),'w').write('\n'.join(r.domain)+'\n')
print('k1',len(k),'picked',len(r))
