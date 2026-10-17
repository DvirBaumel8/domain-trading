import sys; sys.path.insert(0,'scripts')
from functools import lru_cache
from wordfreq import top_n_list, zipf_frequency
import lex
VOC={w:zipf_frequency(w,'en') for w in top_n_list('en',60000) if w.isalpha() and w.isascii() and (len(w)>=3 or w in ('ai','ev','go','my','me','up','us','la','sf','ny','tv','pc','hr','it','io','pr','ar','vr','co','pro','iq','dj','bar'))}
for L in (lex.CITIES,lex.STATES,lex.COUNTRIES,lex.TRADES,lex.TECH,lex.GENERIC_HEADS):
    for w in L: VOC[w]=max(VOC.get(w,0),3.5)
def seg(s):
    @lru_cache(None)
    def best(i):
        if i==len(s): return (0,0.0,())
        res=None
        for j in range(i+1,min(len(s),i+20)+1):
            w=s[i:j]
            if w in VOC and VOC[w]>=2.5:
                r=best(j)
                if r is None: continue
                cand=(r[0]+1, r[1]-VOC[w], (w,)+r[2])
                if res is None or (cand[0],cand[1])<(res[0],res[1]): res=cand
        return res
    r=best(0); return list(r[2]) if r else None
def ttype(tokens):
    s=''.join(tokens); t=set(tokens)
    geo=any(c in s for c in lex.CITIES if len(c)>=5) or any(x in t for x in lex.CITIES+lex.STATES)
    trade=any(x in t for x in lex.TRADES)
    tech=any(x in t for x in lex.TECH)
    if geo and (trade or any(x in t for x in lex.GENERIC_HEADS)): return 'geo_service'
    if geo: return 'geo_other'
    if tech: return 'tech_compliance'
    if trade: return 'service_keyword'
    return 'descriptive_other'
if __name__=='__main__':
    for x in sys.argv[1:]: print(x,seg(x),ttype(seg(x) or []))
