import json,glob,re,html,csv
rows=[]
pat=re.compile(r'^\s*(?:<[^>]+>)*\s*([A-Za-z0-9][A-Za-z0-9-]{0,62}\.com)\s*(?:</[^>]+>)*\s*[–—-]?\s*(\$|€|£|USD\s*|EUR\s*)\s*([\d,\.]+)\s*(k|K)?',re.I)
for f in sorted(glob.glob('raw/dnw_full_*.json')):
    d=json.load(open(f))
    if not isinstance(d,list): continue
    for p in d:
        c=html.unescape(p['content']['rendered'])
        venue='Sedo' if 'Sedo' in p['title']['rendered']+c[:1500] else ('Atom/Afternic' if re.search('Atom|Afternic|GoDaddy',c[:2500]) else 'unknown')
        for para in re.findall(r'<p>(.*?)</p>',c,re.S):
            txt=re.sub(r'<[^>]+>','',para).strip()
            m=pat.match(txt)
            if not m: continue
            name,cur,amt,k=m.groups()
            try: v=float(amt.replace(',',''))
            except: continue
            if k: v*=1000
            desc=txt[m.end():].strip(' –—-:').strip()[:200]
            rows.append(dict(domain=name.lower(),price_raw=f"{cur.strip()}{amt}{k or ''}",currency={'$':'USD','€':'EUR','£':'GBP'}.get(cur.strip(),cur.strip()),price=v,sale_date_approx=p['date'][:10],venue=venue,source='DNW',source_url=p['link'],buyer_desc=desc))
seen=set();out=[]
for r in rows:
    k=(r['domain'],r['price'])
    if k in seen: continue
    seen.add(k); out.append(r)
csv.writer
w=csv.DictWriter(open('raw/dnw_sales.csv','w'),fieldnames=list(out[0].keys())); w.writeheader(); w.writerows(out)
print(len(rows),len(out)); import collections; print(collections.Counter(r['currency'] for r in out))
