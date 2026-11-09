from mz import *
ids=json.load(open('prev.json')); out={}
tex={'player':"bronze armor with warm highlights, crimson and teal cloth, tanned skin, hand painted game style",
'enemy1':"polished bronze plate armor, purple cloth, tanned skin, hand painted game style",
'enemy2':"dark brown leather, rusty iron, olive and gold cloth, tanned scarred skin, hand painted game style"}
for k,i in ids.items():
    d=wait('/openapi/v2/text-to-3d/'+i); print(k,'preview',d['status'],d.get('task_error'))
    if d['status']!='SUCCEEDED': continue
    r=api('POST','/openapi/v2/text-to-3d',{'mode':'refine','preview_task_id':i,'enable_pbr':False,'texture_prompt':tex[k],'ai_model':'meshy-6'})
    out[k]=r['result']; print(k,'refine',r)
json.dump(out,open('refine.json','w'))
