from mz import *
rigs=json.load(open('rig.json')); out={}
ACTS=[89,4,97,102,138,178,8,158,103]   # idle, attack, slash, heavy, block, hit, dead, roll, bash-kick
for k,i in rigs.items():
    d=wait('/openapi/v1/rigging/'+i); print(k,'rig',d['status'],d.get('task_error'))
    if d['status']!='SUCCEEDED': continue
    res=d['result']
    for n in ('rigged_character_glb_url',):
        open(k+'_rigged.glb','wb').write(urllib.request.urlopen(res[n]).read())
    ba=res.get('basic_animations') or {}
    if ba.get('walking_glb_url'): open(k+'_walk.glb','wb').write(urllib.request.urlopen(ba['walking_glb_url']).read())
    r=api('POST','/openapi/v1/animations',{'rig_task_id':i,'action_ids':ACTS}); out[k]=r['result']; print(k,'anim',r)
json.dump(out,open('anim.json','w'))
