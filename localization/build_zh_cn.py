"""Owner-source Chinese build entry point; English upstream manifests stay intact."""
import json, os, pathlib, shutil, subprocess, sys, tempfile
from package_cn import normalize

ROOT=pathlib.Path(__file__).resolve().parent.parent
app_id=sys.argv[1]
index=json.loads((ROOT/'localization/build-index.json').read_text(encoding='utf-8'))
entry=index['apps'][app_id]
kit=ROOT/entry['kitRoot']
source=ROOT/entry['path']
spec=json.loads((source/'app.json').read_text(encoding='utf-8'))
if spec['id']!=app_id or source.parent!=kit/'apps':
    target=kit/'apps'/app_id
    if target.exists():shutil.rmtree(target)
    shutil.copytree(source,target)
    spec['id']=app_id
    (target/'app.json').write_text(json.dumps(spec,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
subprocess.run([sys.executable,'kit/tools/build.py',app_id,'--language','zh-CN'],cwd=kit,check=True)
candidates=list((kit/'dist').glob(app_id+'@'+spec['version']+'-zh.cn.*.tgz'))
if not candidates:raise RuntimeError('Chinese builder did not create an archive')
version=entry['version']
output=ROOT/'dist'/(app_id+'@'+version+'.tgz')
provenance={'id':app_id,'upstreamVersion':spec['version'],'version':version,'language':'zh-CN','source':index['source'],'translation':'小白科技杂物社','sdk':'BMW SDK excluded; vehicle deployment supplies its local SDK'}
normalize(max(candidates,key=lambda f:f.stat().st_mtime),output,app_id,version,provenance,ROOT/'LICENSE')
print(output)
