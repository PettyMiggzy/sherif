from mz import *
rigs=json.load(open('rig.json')); out={}
ACTS=[240,219,220,558,111,188]   # stab, cut, shield push, limp, injured walk, abdominal-wound death
for k,i in rigs.items():
    r=api('POST','/openapi/v1/animations',{'rig_task_id':i,'action_ids':ACTS}); out[k]=r['result']; print(k,r)
json.dump(out,open('anim2.json','w'))
for k,i in out.items():
    d=wait('/openapi/v1/animations/'+i); print(k,d['status'],d.get('task_error'))
    if d['status']=='SUCCEEDED': open(k+'_anims2.glb','wb').write(urllib.request.urlopen(d['result']['animation_glb_url']).read())
print(api('GET','/openapi/v1/balance'))
