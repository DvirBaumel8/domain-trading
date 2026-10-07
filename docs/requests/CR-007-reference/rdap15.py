# Documented public RDAP (IANA bootstrap) lookups. Usage: rdap15.py hosts.txt out.jsonl [threads]
# Records reg (True/False/None), created, status. Retries on 429. Resumable.
import json,os,sys,time,urllib.request,concurrent.futures as cf
BASE={'com':'https://rdap.verisign.com/com/v1/domain/','net':'https://rdap.verisign.com/net/v1/domain/',
 'org':'https://rdap.publicinterestregistry.org/rdap/domain/','ai':'https://rdap.identitydigital.services/rdap/domain/',
 'biz':'https://rdap.nic.biz/domain/','ca':'https://rdap.ca.fury.ca/rdap/domain/'}
def q(h):
    url=BASE[h.rsplit('.',1)[1]]+h
    for a in range(5):
        try:
            j=json.load(urllib.request.urlopen(urllib.request.Request(url,headers={"User-Agent":"Mozilla/5.0 (research)","Accept":"application/rdap+json"}),timeout=25))
            ev={e['eventAction']:e['eventDate'] for e in j.get('events',[])}
            return dict(host=h,reg=True,created=(ev.get('registration') or '')[:10],status=j.get('status',[]))
        except urllib.error.HTTPError as e:
            if e.code==404: return dict(host=h,reg=False,created=None)
            if e.code in (429,503): time.sleep(6+4*a); continue
            return dict(host=h,reg=None,created=None,http=e.code)
        except Exception: time.sleep(2)
    return dict(host=h,reg=None,created=None)
H=[l.strip() for l in open(sys.argv[1]) if l.strip()]; out=sys.argv[2]; th=int(sys.argv[3]) if len(sys.argv)>3 else 6
done=set()
if os.path.exists(out): done={json.loads(l)['host'] for l in open(out) if json.loads(l).get('reg') is not None}
H=[h for h in dict.fromkeys(H) if h not in done]
with open(out,'a') as f, cf.ThreadPoolExecutor(th) as ex:
    for r in ex.map(q,H): f.write(json.dumps(r)+'\n'); f.flush()
print('RDAP_DONE',len(H))
