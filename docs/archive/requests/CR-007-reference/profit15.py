# Profit per $1,500 batch (r14 profit14.py structure). Prices: TEST15 sold names accepted by the chosen rule.
import sys, json, numpy as np, pandas as pd
sys.path.insert(0,'../r11'); from profit import exp_price
T=pd.read_csv('test15_scored.csv'); T['price']=pd.to_numeric(T.price,errors='coerce')
REG,REN,COMM=11.08,11.79,0.20
def per_name(q,P,Y): return (1-COMM)*P*(1-(1-q)**Y)-(REG+sum(REN*(1-q)**y for y in range(1,Y)))
out=[]; Pr=lambda s: out.append(s) or print(s)
for rule,col in (('Chosen rule','acc'),('R0 reference','acc_R0')):
    S=T[(T.y==1)&(T[col]==1)].price.dropna().sort_values(ascending=False).tolist()
    tpr=T[T.y==1][col].mean(); fpr=T[T.y==0][col].mean()
    E={'as computed':exp_price(S)[0],'w/o top 3':exp_price(S[3:])[0],'capped $1,488':exp_price([min(x,1488) for x in S])[0]}
    Pr(f"\n### {rule}: TPR {tpr:.3f}, FPR {fpr:.3f}, lift ≈ {tpr/fpr:.2f}×; accepted sold prices n={len(S)}, median ${np.median(S):,.0f}, top 3 {S[:3]}")
    Pr("Expected sale price (r11 band-median method): "+", ".join(f"{k} ${v:,.0f}" for k,v in E.items()))
    Pr("| q source | q/yr | batch | expected sales | profit as computed | w/o top 3 | capped $1,488 |\n|---|---|---|---|---|---|---|")
    qs=[('investor-reported',x) for x in (.005,.01,.015,.02)]+[(f'backtest, pool p={p:.1%}',p*tpr/(p*tpr+(1-p)*fpr)) for p in (.005,.01)]
    for src,q in qs:
        for N,Y in ((43,3),(50,2)):
            r=[N*per_name(q,e,Y) for e in E.values()]
            Pr(f"| {src} | {q:.2%} | {N} × {Y} yrs | {N*(1-(1-q)**Y):.1f} | {r[0]:+,.0f} | {r[1]:+,.0f} | {r[2]:+,.0f} |")
    for nm,e in E.items():
        for N,Y in ((43,3),(50,2)):
            lo,hi=0,0.5
            for _ in range(60):
                m=(lo+hi)/2; (lo,hi)=(m,hi) if per_name(m,e,Y)<0 else (lo,m)
            Pr(f"break-even q/yr, {nm}, {N}×{Y}y: {hi:.2%}")
Pr(f"\nOutlay if nothing sells: 43 × 3 yrs = ${43*(REG+2*REN):,.0f}; 50 × 2 yrs = ${50*(REG+REN):,.0f}.")
open('profit_out.md','w').write('\n'.join(out))
