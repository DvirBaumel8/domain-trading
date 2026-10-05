import re,html,glob,csv,os
out={};
for f in sorted(glob.glob('raw/dnj/*.htm')):
    b=os.path.basename(f); m=re.search(r'_(\d{4})_(\d{4})?(\d{4})\.htm',b)
    if not m: continue
    y=m.group(1); md=m.group(3); date=f"{y}-{md[:2]}-{md[2:]}"
    url="https://www.dnjournal.com/archive/"+b.replace('_','/',2)
    t=open(f,encoding='latin-1').read()
    s=re.sub(r'<(script|style).*?</\1>','',t,flags=re.S)
    for r in re.findall(r'<tr.*?</tr>',s,re.S|re.I):
        cells=[c.strip() for c in re.sub(r'\s+',' ',html.unescape(re.sub(r'<[^>]+>','|',r))).split('|') if c.strip()]
        if len(cells)<3: continue
        for i,c in enumerate(cells[:-1]):
            if re.fullmatch(r'[A-Za-z0-9-]+\.com',c) and re.fullmatch(r'\$[\d,]+',cells[i+1]):
                d=c.lower(); p=float(cells[i+1][1:].replace(',',''))
                venue=cells[i+2] if i+2<len(cells) else ''
                k=(d,p)
                if k not in out: out[k]=dict(domain=d,price_raw=cells[i+1],currency='USD',price=p,sale_date_approx=date,venue=venue,source='DNJournal',source_url=url,buyer_desc='')
                break
rows=list(out.values())
w=csv.DictWriter(open('raw/dnj_sales.csv','w'),fieldnames=list(rows[0].keys())); w.writeheader(); w.writerows(rows)
import collections; print(len(rows)); print(collections.Counter(r['venue'] for r in rows).most_common(15))
print(sum(1 for r in rows if 300<=r['price']<=10000))
