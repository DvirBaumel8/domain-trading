# Frozen sibling-list builder (backtest census method bt1). Deterministic: seed = domain string.
import csv,random,sys,collections,hashlib; sys.path.insert(0,'scripts')
import lex
C=list(csv.DictReader(open('raw/candidates.csv')))
F=collections.Counter(r['tokens'].split()[0] for r in C); L=collections.Counter(r['tokens'].split()[-1] for r in C)
from seg import VOC
BAD={'ing','ers','ion','the','and','for','ness','less','ment','ful','est','ies','ly'}
ok=lambda w: len(w)>=3 and w not in BAD and VOC.get(w,0)>=3.6
FP=[w for w,_ in F.most_common(400) if ok(w)][:300]; LP=[w for w,_ in L.most_common(400) if ok(w)][:300]
def pool(tok,pos):
    if tok in lex.TECH: return [w for w in lex.TECH if len(w)>=2]
    if tok in lex.TRADES: return lex.TRADES
    return FP if pos=='first' else LP
def siblings(tokens):
    rnd=random.Random(int(hashlib.md5(''.join(tokens).encode()).hexdigest()[:8],16))
    a,z=tokens[0],tokens[-1]; mid=tokens[1:-1]; out=[]
    p=[w for w in pool(a,'first') if w!=a]; rnd.shuffle(p)
    for w in p:
        s=''.join([w]+mid+[z])
        if s not in out and s!=''.join(tokens): out.append(s)
        if len(out)>=10: break
    p=[w for w in pool(z,'last') if w!=z]; rnd.shuffle(p)
    for w in p:
        s=''.join([a]+mid+[w])
        if s not in out and s!=''.join(tokens): out.append(s)
        if len(out)>=20: break
    return out
if __name__=='__main__':
    src=sys.argv[1]; col=sys.argv[2] if len(sys.argv)>2 else 'tokens'
    allsib=set()
    for r in csv.DictReader(open(src)):
        if r['type'].startswith('geo'): continue
        t=r[col].split(); pid='bt1_'+r['domain'][:-4]
        sib=siblings(t)
        with open(f'census/{pid}@v1.csv','w') as f: f.write('stem\n'+'\n'.join(sib)+'\n')
        allsib.update(sib)
    open('raw/census_sibs_'+src.split('/')[-1].split('.')[0]+'.txt','a').write('\n'.join(s+'.com' for s in sorted(allsib))+'\n')
    print(len(allsib))
