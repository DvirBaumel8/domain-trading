import csv,json,sys,urllib.request,time,concurrent.futures as cf,os
inp,outp=sys.argv[1],sys.argv[2]
names=[l.strip() for l in open(inp) if l.strip()]
done={}
if os.path.exists(outp):
    for l in open(outp): j=json.loads(l); done[j['domain']]=j
def q(d):
    for a in range(3):
        try:
            r=urllib.request.urlopen(urllib.request.Request(f"https://rdap.verisign.com/com/v1/domain/{d}",headers={"User-Agent":"Mozilla/5.0"}),timeout=20)
            j=json.load(r); ev={e['eventAction']:e['eventDate'] for e in j.get('events',[])}
            reg=[e.get('vcardArray',[None,[]])[1] for e in j.get('entities',[]) if 'registrar' in e.get('roles',[])]
            rn=''
            for v in reg:
                for x in v:
                    if x[0]=='fn': rn=x[3]
            return dict(domain=d,status=200,created=ev.get('registration','')[:10],expires=ev.get('expiration','')[:10],updated=ev.get('last changed','')[:10],registrar=rn)
        except urllib.error.HTTPError as e:
            if e.code==404: return dict(domain=d,status=404)
            if e.code==429: time.sleep(5*(a+1)); continue
            return dict(domain=d,status=e.code)
        except Exception as e: time.sleep(2)
    return dict(domain=d,status='err')
todo=[n for n in names if n not in done]
with open(outp,'a') as f, cf.ThreadPoolExecutor(8) as ex:
    for i,res in enumerate(ex.map(q,todo)):
        f.write(json.dumps(res)+'\n'); f.flush()
print('done',len(todo))
