const {chromium}=require('playwright');const fs=require('fs');
const SETS=[['p_gladius','player','gladius',9121578],['p_spear','player','spear',9121578],['p_trident','player','trident',9121578],['e1_gladius','enemy1','gladius',4931435],['e2_spear','enemy2','spear',6970924],['e1_trident','enemy1','trident',4931435]];
const only=process.argv[2];
const SPEC=[['idle','Combat_Stance',0,1.67,14],['walk','Walk',0,'W',14],['attack','Left_Slash',0,.85,12],['heavy','Attack',.1,1.5,14],['block','Block1',.8,1.5,6],['hit','Hit_Reaction',0,.8,8],['dead','Dead',0,2.0,12],['roll','Roll_Dodge',0,.8,10],['bash','Simple_Kick',.2,1.1,10]];
(async()=>{const b=await chromium.launch({args:['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist']});
for(const [name,char,weapon,sc] of SETS){ if(only&&only!==name)continue;
 const p=await b.newPage({viewport:{width:400,height:300}});p.on('pageerror',e=>console.log('PE',e.message));
 await p.goto(`http://localhost:8766/rend.html?char=${char}&size=224&yaw=1.2&spy=.14&spz=.1&weapon=${weapon}&sc=${sc}&wq=.8`);await p.waitForFunction('window.READY',null,{timeout:120000});
 const W=await p.evaluate('window.DUR.walk');const out={S:224,anims:{}};
 for(const [k,clip,t0,t1,n] of SPEC){const e=t1==='W'?W:t1;out.anims[k]={n,img:await p.evaluate(([c,a,b2,n])=>window.bake(c,a,b2,n),[clip,t0,e,n])};}
 fs.writeFileSync('set_'+name+'.json',JSON.stringify(out));console.log(name,(fs.statSync('set_'+name+'.json').size/1e6).toFixed(2)+'MB');await p.close();}
await b.close();})();
