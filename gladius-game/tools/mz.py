import os,sys,json,time,urllib.request
env=dict(l.strip().split('=',1) for l in open('../meshy.env') if '=' in l)
K=env['MESHY_KEY']
def api(method,path,body=None):
    r=urllib.request.Request('https://api.meshy.ai'+path,method=method,data=json.dumps(body).encode() if body is not None else None,headers={'Authorization':'Bearer '+K,'Content-Type':'application/json'})
    try: return json.load(urllib.request.urlopen(r,timeout=60))
    except urllib.error.HTTPError as e: print('HTTP',e.code,e.read().decode()[:400]); raise
def wait(path,every=8,limit=1500):
    t=time.time()
    while time.time()-t<limit:
        d=api('GET',path)
        if d['status'] in('SUCCEEDED','FAILED','CANCELED'): return d
        time.sleep(every)
    raise SystemExit('timeout '+path)
