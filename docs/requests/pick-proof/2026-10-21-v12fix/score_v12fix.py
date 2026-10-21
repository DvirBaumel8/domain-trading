#!/usr/bin/env python3
"""v12fix scorer (pick-proof arm A-v12fix, CR-073a item 5; Gavriel-approved 2026-10-21). Copy of scoring/v12/score_v12.py
(sha 4ac02ee3...) with the SAME frozen weights v12-params.pkl sha d72d3e2e... Definitions:
- word_count imputation: wc = 2 for every K1 name, taken from our own 2-word split (K1 = exactly 2 tokens). The
  wordcount lookup tables are not used. Input names must all be K1 names (the caller passes only K1 rows).
- price-neutral rank: price is removed from the scorer's inputs. (v12's 15 features contain no price column; this
  scorer accepts domain names only, so no price can enter.) RANKING ONLY."""
import sys,os,argparse,hashlib,pickle,pandas as pd,numpy as np
R='/workspace/domain-trading/'; sys.path.insert(0,R+'harness'); import lanes
PSHA='d72d3e2e4196b97936480629bcf2344d8aa74ebd495011c68d9098bc6ef90cd3'
b=open(R+'scoring/v12/v12-params.pkl','rb').read(); assert hashlib.sha256(b).hexdigest()==PSHA,'v12-params.pkl sha mismatch'
M=pickle.loads(b); m,F=M['model'],M['features']
L=['geo','regulation','trend','tech_x_industry','short_brand','descriptive']
def score(domains):
    d=pd.DataFrame({'domain':[x.strip().lower() for x in domains if str(x).strip()]}).drop_duplicates('domain').reset_index(drop=True)
    d['sld']=d.domain.str.replace(r'\.com$','',regex=True)
    d=pd.concat([d,pd.DataFrame([lanes.shape(x) for x in d.sld])],axis=1); d['lane']=d.sld.map(lanes.lane)
    for c in L: d['l_'+c]=(d.lane==c).astype(int)
    d['wc']=2; d['wc_imputed']=True   # imputation: K1 2-word split
    d['v12fix_score']=m.predict_proba(d[F].astype(float))[:,1].round(4)
    d['v12fix_rank']=d.v12fix_score.rank(ascending=False,method='first').astype(int)
    return d.sort_values('v12fix_rank')[['domain','v12fix_score','v12fix_rank','wc_imputed']]
if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('inp'); ap.add_argument('--col',default='domain'); ap.add_argument('--out')
    a=ap.parse_args(); score(pd.read_csv(a.inp)[a.col].astype(str).tolist()).to_csv(a.out or sys.stdout,index=False)
