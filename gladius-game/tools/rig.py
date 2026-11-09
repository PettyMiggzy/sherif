from mz import *
ids=json.load(open('refine.json')); out={}
for k,i in ids.items():
    d=wait('/openapi/v2/text-to-3d/'+i); print(k,'refine',d['status'],d.get('task_error'))
    if d['status']!='SUCCEEDED': continue
    open(k+'.png','wb').write(urllib.request.urlopen(d['thumbnail_url']).read()) if d.get('thumbnail_url') else None
    r=api('POST','/openapi/v1/rigging',{'input_task_id':i,'height_meters':1.8}); out[k]=r['result']; print(k,'rig',r)
json.dump(out,open('rig.json','w'))
