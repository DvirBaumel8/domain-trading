# Homepage "in use" check, same classification as v9.1 C19 (scripts/census_run_lib.py site()):
# in_use = HTTP 200, final host is the domain itself (no off-domain redirect), no parking/for-sale text, >=200 chars visible text.
# One GET of the public homepage per host (max 300 KB). Usage: site15.py hosts.txt out.jsonl [threads]
import json,os,sys,time,socket,concurrent.futures as cf
sys.path.insert(0,'../scripts')
socket.setdefaulttimeout(12)
from census_run_lib import site
def job(h):
    try: socket.getaddrinfo(h,80)
    except Exception: return dict(host=h,state='no_dns',at=time.strftime('%Y-%m-%dT%H:%M'))
    try: st=site(h)
    except Exception: st='error'
    return dict(host=h,state=st,at=time.strftime('%Y-%m-%dT%H:%M'))
H=[l.strip() for l in open(sys.argv[1]) if l.strip()]; out=sys.argv[2]; th=int(sys.argv[3]) if len(sys.argv)>3 else 32
done=set()
if os.path.exists(out): done={json.loads(l)['host'] for l in open(out)}
H=[h for h in dict.fromkeys(H) if h not in done]
with open(out,'a') as f, cf.ThreadPoolExecutor(th) as ex:
    for r in ex.map(job,H): f.write(json.dumps(r)+'\n'); f.flush()
print('SITE_DONE',len(H))
