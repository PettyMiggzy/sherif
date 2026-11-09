from mz import *
chars={
 'player':"Roman gladiator champion, muscular, bare chest with leather harness, bronze shoulder guard on one shoulder, bronze greaves, pleated crimson-and-teal tunic skirt, short red cape, bronze crested helmet with visor, leather sandals, stylized game character, full body, empty hands, no weapon, no shield",
 'enemy1':"Roman gladiator murmillo, heavy segmentata plate armor, large bronze helmet with tall purple crest and visor grille, purple tunic, manica arm guard, greaves, stylized game character, full body, empty hands, no weapon, no shield",
 'enemy2':"Thracian gladiator, lean and scarred, dark brown leather armor with iron studs, open-faced iron helmet with tall feather plume, bandaged forearms, gold-trimmed olive tunic, greaves, stylized game character, full body, empty hands, no weapon, no shield",
}
ids={}
for k,p in chars.items():
    d=api('POST','/openapi/v2/text-to-3d',{'mode':'preview','prompt':p,'ai_model':'meshy-6','pose_mode':'t-pose','topology':'triangle','target_polycount':30000,'should_remesh':True})
    ids[k]=d['result']; print(k,d)
json.dump(ids,open('prev.json','w'))
