import json,subprocess
N=['HOMEOWNER CLAIMS','HOMEOWNERCLAIMS','HOMEOWNERS CLAIMS','ADVENTURE DEALS','ADVENTUREDEALS','ELITE BANKRUPTCY','ELITEBANKRUPTCY','AFFORDABLE LUMBER','AFFORDABLELUMBER','SNOWPLOW SOLUTIONS','SNOW PLOW SOLUTIONS','FIDUCIARY LAWYERS','FIDUCIARY LAWYER']
def call(qs):
    q={"query":{"query_string":{"query":qs}},"size":100,"_source":["wordmark","alive","serialNumber","internationalClass","ownerName"]}
    r=subprocess.run(['curl','-s','-m','60','-A','curl/8.5','-X','POST','https://tmsearch.uspto.gov/prod-stage-v1-0-0/tmsearch','-H','Content-Type: application/json','-d',json.dumps(q)],capture_output=True,text=True).stdout
    try:return json.loads(r)
    except Exception: return {'ERROR':r[:300]}
out={'control ISLAND BABY':call('wordmark:("ISLAND BABY")'),'main':call('wordmark:('+' OR '.join(f'"{n}"' for n in N)+')')}
json.dump(out,open('evidence/uspto.json','w'),indent=1)
for k,v in out.items():
    if 'ERROR' in v:print(k,v);continue
    print(k,v['hits']['totalValue'])
    for h in v['hits']['hits']:s=h['source'];print(' ',s['wordmark'],s['alive'],s.get('internationalClass'),s.get('ownerName'))
