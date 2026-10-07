# FWD-13 drop-outcome check. Run on/after 2026-10-08 (drop window for join-by 10/06 is 2026-10-06 ~21:00 IDT onward).
# Verisign RDAP only (documented public API), sequential, 0.3 s gap. Appends to fwd13_outcome.jsonl.
# outcome: available_after_drop (404) | caught_or_reg (created >= 2026-10-06) | restored (same created, no pendingDelete) | still_pending | unknown
import json,time,urllib.request,sys
base={json.loads(l)['domain']:json.loads(l) for l in open('rdap_fwd13.jsonl')}
out=open('fwd13_outcome.jsonl','a')
for d,b in base.items():
    rec=dict(domain=d,checked=time.strftime('%Y-%m-%dT%H:%M:%S%z'),created_before=b.get('created'))
    try:
        j=json.load(urllib.request.urlopen(urllib.request.Request(f"https://rdap.verisign.com/com/v1/domain/{d}",headers={"User-Agent":"Mozilla/5.0"}),timeout=20))
        ev={e['eventAction']:e['eventDate'] for e in j.get('events',[])}; c=ev.get('registration','')[:10]; st=j.get('status',[])
        reg=''
        for e in j.get('entities',[]):
            if 'registrar' in e.get('roles',[]):
                for x in e.get('vcardArray',[None,[]])[1]:
                    if x[0]=='fn': reg=x[3]
        rec.update(created_now=c,status=st,registrar=reg)
        rec['outcome']='still_pending' if 'pending delete' in st else ('caught_or_reg' if c>='2026-10-06' else 'restored')
    except urllib.error.HTTPError as e:
        rec['outcome']='available_after_drop' if e.code==404 else 'unknown'; rec['http']=e.code
    except Exception as e: rec['outcome']='unknown'
    out.write(json.dumps(rec)+'\n'); time.sleep(0.3)
print('done')
