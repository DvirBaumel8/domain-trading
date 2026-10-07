# in_use per v9.1 C19: HTTP 200, final host = sibling (no off-domain redirect), not parking list, >=200 chars visible text.
import json,sys,re,ssl,urllib.request,os,time,concurrent.futures as cf,socket
socket.setdefaulttimeout(15)
ctx=ssl.create_default_context(); ctx.check_hostname=False; ctx.verify_mode=ssl.CERT_NONE
UA={"User-Agent":"Mozilla/5.0 (X11; Linux x86_64) Chrome/124"}
PARK=re.compile(r'(domain (is )?for sale|buy this domain|parked|this domain (is|has been) registered|afternic|sedo|dan\.com|hugedomains|namecheap.*parking|godaddy.*(parked|coming soon)|make an offer|is available for purchase|domain may be for sale|not yet connected|launching soon|coming soon|bodis|parkingcrew|above\.com|atom\.com|squadhelp|spaceship|lease to own|future home of|under construction)',re.I)
def rdap(d):
    for a in range(3):
        try: urllib.request.urlopen(urllib.request.Request(f"https://rdap.verisign.com/com/v1/domain/{d}",headers=UA),timeout=20); return True
        except urllib.error.HTTPError as e:
            if e.code==404: return False
            if e.code==429: time.sleep(5); continue
            return None
        except Exception: time.sleep(2)
    return None
def site(d):
    for sch in ("https://","http://"):
        try:
            r=urllib.request.urlopen(urllib.request.Request(sch+d,headers=UA),timeout=12,context=ctx)
            if r.status!=200: continue
            body=r.read(300000).decode('utf-8','ignore'); fh=r.geturl().split('/')[2].lower().split(':')[0]
            onhost=fh==d or fh=='www.'+d
            vis=re.sub(r'\s+',' ',re.sub(r'<[^>]+>',' ',re.sub(r'<(script|style|noscript).*?</\1>','',body,flags=re.S|re.I))).strip()
            if not onhost: return 'redirect_offdomain:'+fh
            if PARK.search(body): return 'forsale_or_parked'
            if len(vis)<200: return 'thin'
            return 'in_use'
        except Exception as e: continue
    return 'no_http'
def job(d):
    reg=rdap(d); st='unregistered' if reg is False else ('rdap_err' if reg is None else site(d))
    return dict(domain=d,registered=reg,state=st,at=time.strftime('%Y-%m-%dT%H:%M'))
