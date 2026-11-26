import json,os,sys
def scaffold(name,title,desc,reqs,dataset_fields,view_fields,input_schema,sample_input):
    root=f'/workspace/apify-actors/{name}'
    for d in ['.actor','src','tests',f'storage/key_value_stores/default']: os.makedirs(f'{root}/{d}',exist_ok=True)
    actor={"actorSpecification":1,"name":name,"title":title,"description":desc,"version":"0.1","buildTag":"latest",
           "meta":{"templateId":"python-empty"},"input":"./input_schema.json","output":"./output_schema.json",
           "storages":{"dataset":"./dataset_schema.json"},"dockerfile":"../Dockerfile","readme":"../README.md",
           "minMemoryMbytes":256,"maxMemoryMbytes":1024,"defaultRunOptions":{"memoryMbytes":256}}
    json.dump(actor,open(f'{root}/.actor/actor.json','w'),indent=2)
    json.dump(input_schema,open(f'{root}/.actor/input_schema.json','w'),indent=2)
    json.dump({"actorOutputSchemaVersion":1,"title":f"{title} output","properties":{"results":{"type":"string","title":"Results","description":"All result rows in the default dataset","template":"{{links.apiDefaultDatasetUrl}}/items"}}},open(f'{root}/.actor/output_schema.json','w'),indent=2)
    json.dump({"actorSpecification":1,"fields":{"type":"object","properties":dataset_fields},
               "views":{"overview":{"title":"Overview","transformation":{"fields":view_fields},
                        "display":{"component":"table","properties":{f:{"label":f} for f in view_fields}}}}},
              open(f'{root}/.actor/dataset_schema.json','w'),indent=2)
    open(f'{root}/requirements.txt','w').write('\n'.join(reqs)+'\n')
    open(f'{root}/Dockerfile','w').write("""FROM apify/actor-python:3.13
COPY --chown=myuser:myuser requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY --chown=myuser:myuser . ./
RUN python3 -m compileall -q src/
CMD ["python3", "-m", "src"]
""")
    open(f'{root}/.dockerignore','w').write(".git\n.venv\nstorage\n__pycache__\ntests\n")
    open(f'{root}/.gitignore','w').write("storage/\n__pycache__/\n.venv/\n")
    open(f'{root}/src/__init__.py','w').write('')
    open(f'{root}/src/__main__.py','w').write("import asyncio\nfrom .main import main\n\nasyncio.run(main())\n")
    json.dump(sample_input,open(f'{root}/storage/key_value_stores/default/INPUT.json','w'),indent=2)
