const {chromium}=require('playwright');const fs=require('fs');
const BASE=[['p','player','gladius',9121578],['p','player','spear',9121578],['p','player','trident',9121578],['e1','enemy1','gladius',4931435],['e2','enemy2','spear',6970924],['e1','enemy1','trident',4931435]];
const SPEC=[['idle','Combat_Stance',0,1.67,14],['walk','Walk',0,'W',14],['attack','Right_Hand_Sword_Slash',.1,.9,12],['stab','Thrust_Slash',.6,2.4,14],['heavy','Attack',.1,1.5,14],['block','Block1',.8,1.5,6,'shield'],['hit','Hit_Reaction',0,.8,8],['dead','Dead',0,2.0,12],['dead2','Fall_Dead_from_Abdominal_Injury',0,2.6,12],['roll','Roll_Dodge',0,.8,10],['bash','Shield_Push_Left',.3,1.4,10,'shield'],['limp','Limping_Walk',0,3.5,16],['hurtwalk','Injured_Walk',0,4.0,12]];
const only=process.argv[2];
(async()=>{const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
for(const [pre,char,weapon,sc] of BASE) for(const ns of [false,true]){ const name=pre+'_'+weapon+(ns?'_ns':''); if(only&&only!==name)continue;
 const p=await b.newPage({viewport:{width:400,height:300}});p.on('pageerror',e=>console.log('PE',e.message));
 await p.goto(`http://localhost:8766/rend.html?char=${char}&size=224&yaw=1.2&spy=.14&spz=.1&weapon=${weapon}&sc=${sc}&wq=.74${ns?'&shield=0':''}`);await p.waitForFunction('window.READY',null,{timeout:120000});
 const W=await p.evaluate('window.DUR.walk');const out={S:224,anims:{}};
 for(const [k,clip,t0,t1,n,need] of SPEC){ if(ns&&need==='shield')continue; const e=t1==='W'?W:t1;
  const img=await p.evaluate(([c,a,b2,n])=>window.bake(c,a,b2,n),[clip,t0,e,n]); const j=await p.evaluate('window.LASTJ');
  out.anims[k]={n,img,j:j.map(f=>f.map(v=>Math.round(v)))};}
 fs.writeFileSync('set2_'+name+'.json',JSON.stringify(out));console.log(name,(fs.statSync('set2_'+name+'.json').size/1e6).toFixed(2)+'MB');await p.close();}
await b.close();})();
