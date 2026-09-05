import json, urllib.request, urllib.error

BASE = 'http://localhost:3000'
PW = 'admin'

def call(path, data=None):
    url = BASE + path
    if data is None:
        req = urllib.request.Request(url)
    else:
        req = urllib.request.Request(url, data=json.dumps(data).encode('utf-8'),
                                     headers={'Content-Type': 'application/json'}, method='POST')
    try:
        with urllib.request.urlopen(req) as r:
            return r.status, json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read().decode('utf-8'))

with open('school-classes.json', encoding='utf-8') as f:
    target = json.load(f)
target_names = {c['name'] for c in target['classes']}

# 现状
st, state = call('/api/state')
existing = state.get('classes', [])
print(f'当前班级数: {len(existing)}')

# 删除不属于目标清单的班级（旧的 demo 格式）
for c in existing:
    if c['name'] not in target_names:
        code, resp = call('/api/classes/delete', {'id': c['id'], 'password': PW})
        print(f"  删除 [{c['name']}] -> {code} {resp.get('message','')}")

# 重新拉取，避免重复创建
st, state = call('/api/state')
have = {c['name'] for c in state.get('classes', [])}

# 创建 27 个真实班级
added = 0
for c in target['classes']:
    if c['name'] in have:
        print(f"  已存在 [{c['name']}] 跳过")
        continue
    code, resp = call('/api/classes/add', {'name': c['name']})
    if code == 200:
        added += 1
        print(f"  新增 [{c['name']}] -> ok")
    else:
        print(f"  新增 [{c['name']}] -> {code} {resp.get('message','')}")

# 最终校验
st, state = call('/api/state')
final = sorted(state.get('classes', []), key=lambda x: x['name'])
print(f'\n最终班级数: {len(final)}')
for c in final:
    print('  ', c['name'])
