import sys,csv,re,collections; sys.path.insert(0,'scripts')
from seg import seg,ttype,VOC
rows=[]; c=collections.Counter()
with open('/tmp/sn/deletinglist.txt',encoding='utf-8',errors='ignore') as f:
    hdr=f.readline()
    for l in f:
        p=[x.strip() for x in l.split('\t')]
        if len(p)<7: continue
        d=p[0].lower()
        if not d.endswith('.com'): continue
        c['com']+=1; sld=d[:-4]
        if re.search(r'[\d-]',sld) or len(sld)>25: continue
        t=seg(sld)
        if not t or not (2<=len(t)<=3) or any(VOC.get(w,0)<3.6 for w in t) or any(len(w)<3 and w not in ('ai','ev','hr','it','ny','la','my','go','up','us','tv','pc','io','vr','ar','pr','dj','iq','sf','co') for w in t): continue
        c['target_like']+=1
        rows.append(dict(domain=d,join_by=p[2],seller=p[5],bid=p[1],tokens=' '.join(t),word_count=len(t),sld_len=len(sld),type=ttype(t)))
print(c, collections.Counter(r['type'] for r in rows), collections.Counter(r['seller'] for r in rows).most_common(5))
w=csv.DictWriter(open('raw/sn_target_like.csv','w'),fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
