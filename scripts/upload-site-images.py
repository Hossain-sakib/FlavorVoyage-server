#!/usr/bin/env python3
"""Upload owned site images to Cloudinary using private hosting configuration.
Secrets remain in memory. The output manifest contains public delivery URLs only.
"""
import hashlib, json, os, pathlib, time, urllib.request, urllib.parse, uuid
ROOT=pathlib.Path(__file__).resolve().parents[1]
CLIENT=ROOT.parent/'FlavorVoyage---client'
SITE='ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf'
def read(url,headers=None):
    with urllib.request.urlopen(urllib.request.Request(url,headers=headers or {}),timeout=45) as r:return json.load(r)
headers={'Authorization':'Bearer '+os.environ['NETLIFY_AUTH_TOKEN']}
site=read('https://api.netlify.com/api/v1/sites/'+SITE,headers)
entries=read(f'https://api.netlify.com/api/v1/accounts/{site["account_id"]}/env?site_id={SITE}',headers)
env={e['key']:next((v['value'] for v in e['values'] if v.get('context')=='all'),e['values'][0]['value']) for e in entries if e.get('values')}
cloud,key,secret=(env.get('CLOUDINARY_'+n) for n in ['CLOUD_NAME','API_KEY','API_SECRET'])
if not all([cloud,key,secret]):
    parsed=urllib.parse.urlparse(env.get('CLOUDINARY_URL',''))
    cloud,key,secret=parsed.hostname,parsed.username,parsed.password
if not all([cloud,key,secret]):raise SystemExit('Cloudinary hosting configuration is incomplete.')
previous=ROOT.parent/'.deployment/cloudinary-images.json'
fallback=CLIENT/'scripts/site-images.json'
manifest=json.loads(previous.read_text()) if previous.exists() else json.loads(fallback.read_text()) if fallback.exists() else {}
assets=sorted((CLIENT/'public/images').rglob('*'))+[CLIENT/'public/favicon.svg']
count=0
for path in assets:
    if not path.is_file():continue
    relative='/'+str(path.relative_to(CLIENT/'public'))
    if relative in manifest:continue
    data=path.read_bytes()
    params={'folder':'flavorvoyage/site','overwrite':'false','public_id':hashlib.sha256(data).hexdigest()[:16]+'-'+path.stem,'timestamp':str(int(time.time()))}
    signed='&'.join(f'{k}={v}' for k,v in sorted(params.items()))+secret
    fields={**params,'api_key':key,'signature':hashlib.sha1(signed.encode()).hexdigest()}
    boundary=uuid.uuid4().hex;parts=[]
    for name,value in fields.items():parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="{name}"\r\n\r\n{value}\r\n'.encode())
    parts.append(f'--{boundary}\r\nContent-Disposition: form-data; name="file"; filename="{path.name}"\r\nContent-Type: application/octet-stream\r\n\r\n'.encode()+data+b'\r\n')
    parts.append(f'--{boundary}--\r\n'.encode())
    request=urllib.request.Request(f'https://api.cloudinary.com/v1_1/{cloud}/image/upload',data=b''.join(parts),headers={'Content-Type':'multipart/form-data; boundary='+boundary})
    with urllib.request.urlopen(request,timeout=60) as response:uploaded=json.load(response)
    manifest[relative]=uploaded['secure_url'];count+=1
    previous.write_text(json.dumps(manifest,indent=2)+'\n')
site_assets={relative:manifest[relative] for relative in sorted('/'+str(p.relative_to(CLIENT/'public')) for p in assets if p.is_file())}
(CLIENT/'scripts/site-images.json').write_text(json.dumps(site_assets,indent=2)+'\n')
(CLIENT/'src/site-images.json').write_text(json.dumps({key:site_assets[key] for key in ['/favicon.svg','/images/stories/refresh.jpg','/images/stories/tea.jpg']},indent=2)+'\n')
print(json.dumps({'uploaded':count,'siteImages':len(site_assets),'manifest':'scripts/site-images.json'}))
