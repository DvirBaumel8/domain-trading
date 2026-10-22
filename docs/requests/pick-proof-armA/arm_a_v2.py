"""Pick-proof arm A from DOM's FROZEN SERVER POOL (CR-073 plan s4; from 2026-10-23, pickproof-v2 days).
Model: Grok Bot (Buyer); prompt: Buyer profile + task 2026-10-22 19:10 IDT. Scripted, no LLM, no hand-picking.
Steps: GET /pickproof/D/manifest + /pool (bots key, X-Bot-Name: Buyer) -> verify pool_sha256 -> pool rows .com letters-only <=$40
-> K1 = same bots 2-word lane rule as arm_a.py (lanes.shape: 2 tokens, each >=2 letters & zipf>=3, total <=10) -> v12 rank -> top k.
Usage: python3 arm_a_v2.py D OUTDIR [--post]   (without --post: dry, writes files only)"""
import sys,os,json,hashlib,subprocess,urllib.request
import pandas as pd
from wordfreq import zipf_frequency as zf
R=os.path.abspath(os.path.join(os.path.dirname(__file__),'..','..')); sys.path.insert(0,R+'/harness'); import lanes
D,OUT=sys.argv[1],sys.argv[2]; POST='--post' in sys.argv
P='https://domain-trading-api-proxy.dvirbaumel9.workers.dev'; KEY=open(os.path.expanduser('~/.config/grok-bots/bots.token')).read().strip()
def api(path,body=None,idem=None):
    h={'Authorization':'Bearer '+KEY,'X-Bot-Name':'Buyer','Content-Type':'application/json','User-Agent':'curl/8.5.0'}
    if idem:h['Idempotency-Key']=idem
    rq=urllib.request.Request(P+path,data=json.dumps(body).encode() if body is not None else None,headers=h,method='POST' if body is not None else 'GET')
    try:
        with urllib.request.urlopen(rq,timeout=120) as r:return json.load(r)
    except urllib.error.HTTPError as e: sys.exit(f'HTTP {e.code} {path}: {e.read()[:400]!r}')
pool=api(f'/pickproof/{D}/pool'); man=api(f'/pickproof/{D}/manifest')
if man.get('sealed') and POST: sys.exit('day already sealed')
f=pool['fields']; rows=pool['rows']; i=f.index
sha=hashlib.sha256(json.dumps([[r[i('domain')],r[i('source')],r[i('price_cents')]] for r in rows],separators=(',',':')).encode()).hexdigest()
print('pool_sha256 server',pool['pool_sha256'],'recomputed',sha,'MATCH' if sha==pool['pool_sha256'] else 'MISMATCH(recorded, server pool used as-is)')
p=pd.DataFrame(rows,columns=f); p['price_usd']=p.price_cents/100
p=p[p.domain.str.fullmatch(r'[a-z]+\.com',na=False)&(p.price_usd<=40)]
n0=len(p); sh=pd.DataFrame([lanes.shape(x) for x in p.domain.str[:-4]],index=p.index); p=p.join(sh)
tw=p.tokens.str.split(); p=p[(tw.str.len()==2)&(p.length<=10)&tw.map(lambda w:all(len(x)>=2 and zf(x,'en')>=3.0 for x in w))]
out=os.path.join(R,'sourcing/pick-proof',OUT); os.makedirs(out,exist_ok=True)
p[['domain','price_usd','source','passes_k1','is_two_word','tokens']].to_csv(f'{out}/k1.csv',index=False)
subprocess.run([sys.executable,f'{R}/scoring/v12/score_v12.py',f'{out}/k1.csv','--col','domain','--out',f'{out}/ranked.csv'],check=True,stdout=subprocess.DEVNULL)
k=int(man.get('k',100))
r=pd.read_csv(f'{out}/ranked.csv').sort_values('v12_rank').head(k).merge(p[['domain','price_usd','source','is_two_word']],on='domain',how='left')
r.to_csv(f'{out}/arm_a.csv',index=False); body={'names':r.domain.tolist()}
bj=json.dumps(body); open(f'{out}/body.json','w').write(bj)
src=r.source.value_counts().to_dict()
info=dict(date=D,recipe=man['recipe']['version'],pool_n=pool['pool_n'],pool_sha256=pool['pool_sha256'],sha_check=sha==pool['pool_sha256'],sources=man['sources'],
  local_pool=n0,k1=len(p),picked=len(r),picks_by_source=src,v2_two_word_in_picks=int(r.is_two_word.sum()),
  code_sha256=hashlib.sha256(open(__file__,'rb').read()).hexdigest(),body_sha256=hashlib.sha256(bj.encode()).hexdigest())
print(json.dumps(info,indent=1))
if POST:
    resp=api(f'/pickproof/{D}/picks',body,idem=f'buyer-pickproof-{D}-v2a'); info['response']=resp; print(json.dumps(resp)[:600])
json.dump(info,open(f'{out}/run.json','w'),indent=1)
