#!/usr/bin/env python3
"""Read-only availability checks. Output contains no customer records or credentials."""
import json, urllib.request, urllib.error
BASE='https://flavor-voyage.netlify.app'
def read(path):
    with urllib.request.urlopen(BASE+path,timeout=25) as response:
        assert response.status==200,path
        return response.read(),response.headers
html,headers=read('/')
assert b'Switch to dark mode' in html and headers.get('Content-Security-Policy')
health=json.loads(read('/api/health')[0]);assert health['status']=='ok' and health['storage'] in ['netlify-blobs','mongodb']
products=json.loads(read('/api/products')[0]);assert len(products)>0
assert all(p.get('image','').startswith('https://res.cloudinary.com/') for p in products)
for path in ['/api/admin/data','/api/admin/operations','/api/notifications']:
    try:read(path);raise AssertionError('Private endpoint exposed: '+path)
    except urllib.error.HTTPError as error:assert error.code==401
assert b'<urlset' in read('/sitemap.xml')[0]
print(json.dumps({'available':True,'activeListings':len(products),'database':True,'privateEndpoints':True}))
