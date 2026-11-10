#!/usr/bin/env python3
"""Upload the built sibling client and bundled API to the Flavor Voyage test site.
Credentials are read from NETLIFY_AUTH_TOKEN and sent only to api.netlify.com.
Run npm run build in the client and npm run build:netlify in the server first.
Default creates a draft; --publish ID promotes an already-verified deployment.
"""
import argparse, hashlib, json, os, pathlib, urllib.request, urllib.parse, zipfile

SITE = 'ddfb7371-8f19-4a9d-9c76-fd4c1a65afbf'
BASE = 'https://api.netlify.com/api/v1'
ROOT = pathlib.Path(__file__).resolve().parents[1]
CLIENT = ROOT.parent / 'FlavorVoyage---client' / 'dist'
parser = argparse.ArgumentParser()
parser.add_argument('--publish')
parser.add_argument('--status')
args = parser.parse_args()
token = os.environ.get('NETLIFY_AUTH_TOKEN')
if not token: raise SystemExit('NETLIFY_AUTH_TOKEN is not configured.')

def request(path, method='GET', data=None, content_type='application/json'):
    body = json.dumps(data).encode() if data is not None and content_type == 'application/json' else data
    req = urllib.request.Request(BASE + path, data=body, method=method, headers={'Authorization': 'Bearer ' + token, 'Content-Type': content_type, 'Accept': 'application/json'})
    with urllib.request.urlopen(req, timeout=60) as response:
        raw = response.read()
        return json.loads(raw) if raw else {}

def safe(deploy):
    return {key: deploy.get(key) for key in ['id', 'site_id', 'state', 'draft', 'deploy_ssl_url', 'ssl_url', 'published_at', 'error_message', 'required', 'required_functions']}

if args.publish:
    result = request(f'/sites/{SITE}/deploys/{args.publish}/restore', 'POST')
elif args.status:
    result = request('/deploys/' + args.status)
else:
    # Non-secret, site-scoped settings only. No deployment token is copied into hosting.
    site = request('/sites/' + SITE)
    if site['name'] != 'flavor-voyage': raise SystemExit('Unexpected target project.')
    env_path = f'/accounts/{site["account_id"]}/env?site_id={SITE}'
    existing = request(env_path)
    desired = {'APP_ORIGIN': 'https://flavor-voyage.netlify.app', 'ENABLE_DEMO': 'true'}
    new = [{'key': key, 'values': [{'context': 'all', 'value': value}]} for key, value in desired.items() if key not in {entry['key'] for entry in existing}]
    if new: request(env_path, 'POST', new)
    bundle = ROOT / '.netlify/functions/api/api.js'
    if not bundle.exists() or not (CLIENT / 'index.html').exists(): raise SystemExit('Build both applications before deployment.')
    zip_path = ROOT / '.netlify/api.zip'
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as archive: archive.write(bundle, 'api.js')
    function_bytes = zip_path.read_bytes()
    files = {'/' + str(p.relative_to(CLIENT)): p for p in CLIENT.rglob('*') if p.is_file()}
    hashes = {name: hashlib.sha1(p.read_bytes()).hexdigest() for name, p in files.items()}
    function_hash = hashlib.sha256(function_bytes).hexdigest()
    result = request(f'/sites/{SITE}/deploys', 'POST', {'draft': True, 'files': hashes, 'functions': {'api': function_hash}, 'title': 'FlavorVoyage public drinks website + business marketplace'})
    deploy_id = result['id']
    print(json.dumps({'draft_created': deploy_id}), flush=True)
    for name, digest in hashes.items():
        if digest in (result.get('required') or []):
            request('/deploys/' + deploy_id + '/files/' + urllib.parse.quote(name.lstrip('/'), safe='/'), 'PUT', files[name].read_bytes(), 'application/octet-stream')
    if function_hash in (result.get('required_functions') or []):
        request('/deploys/' + deploy_id + '/functions/api?runtime=nodejs24.x', 'PUT', function_bytes, 'application/octet-stream')
    result = request('/deploys/' + deploy_id)
    target = ROOT.parent / '.deployment' / 'flavor-voyage-netlify-deploy.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(safe(result), indent=2))
print(json.dumps(safe(result)), flush=True)
