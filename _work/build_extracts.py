# Gera extratos de contexto para as tarefas de documentos (D07-D08 telas; API-1..5 api.md §4).
# Uso: python _work/build_extracts.py   (na raiz). Saída: _work/screens/{A,B}.md e _work/api/<NN-slug>.md
import io, re, glob, os
os.makedirs('_work/screens', exist_ok=True); os.makedirs('_work/api', exist_ok=True)
def sect(s, name):
    m = re.search(r'^## ' + name + r'\n(.*?)(?=^## )', s, flags=re.M | re.S)
    return m.group(1).strip() if m else ''
stories = {}
for f in sorted(glob.glob('docs/backlog/story-*.md')):
    s = io.open(f, encoding='utf-8').read()
    sid = 'US-' + os.path.basename(f)[6:9]
    t = re.search(r'^title:\s*"?(.*?)"?\s*$', s, flags=re.M)
    stories[sid] = (os.path.basename(f), t.group(1) if t else '', {k: sect(s, k) for k in
                    ['Frontend', 'Campos', 'Validações', 'API', 'Casos de erro', 'Eventos gerados', 'Auditoria']})
# --- telas
A = ['SCR-%03d' % i for i in list(range(1, 16)) + [101, 102, 103, 104, 105, 106, 111, 113, 115, 116]]
B = ['SCR-%03d' % i for i in [29, 30, 31, 32, 33, 34, 35, 36, 37, 39, 41, 107, 108, 109, 110, 112, 114]]
inv = io.open('docs/mvp-01/features.md', encoding='utf-8').read()
rows = {r.group(1): r.group(0) for r in re.finditer(r'^\| (SCR-\d{3}) \|.*$', inv, flags=re.M)}
for name, group in (('A', A), ('B', B)):
    out = ['# Extrato de telas — grupo %s (gerado por _work/build_extracts.py; não é entregável)\n' % name,
           '## Inventário (features.md, Apêndice A)\n', '| ID | Tela | Rota | Stories principais |', '|---|---|---|---|']
    out += [rows[g] for g in group if g in rows]
    out.append('\n## Seções "Frontend" das stories que citam telas do grupo\n')
    for sid, (fn, title, d) in stories.items():
        cited = sorted(set(re.findall(r'SCR-\d{3}', d['Frontend'])) & set(group))
        if cited:
            out.append('### %s — %s (`%s`) — cita: %s\n%s\n' % (sid, title, fn, ', '.join(cited), d['Frontend']))
    io.open('_work/screens/%s.md' % name, 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
# --- API
api = io.open('docs/mvp-01/api.md', encoding='utf-8').read()
sec3 = api[api.index('## 3. Catálogo de endpoints'):api.index('## 4. Especificação por endpoint')]
parts = re.split(r'^(### 3\.\d+ .*)$', sec3, flags=re.M)
slug = {'3.1': '01-session-me', '3.2': '02-processes', '3.3': '03-documents', '3.4': '04-templates', '3.5': '05-dfd',
        '3.6': '06-etp', '3.7': '07-price-research-suppliers', '3.8': '08-risks', '3.9': '09-term-of-reference',
        '3.10': '10-workflow', '3.11': '11-approvals-inbox', '3.12': '12-comments-attachments',
        '3.13': '13-dashboard-notifications-audit', '3.14': '14-tenant-administration', '3.15': '15-platform-health'}
for i in range(1, len(parts), 2):
    title, body = parts[i].strip(), parts[i + 1]
    num = re.match(r'### (3\.\d+)', title).group(1)
    owners = set()
    for r in re.finditer(r'^\| ([A-Z]+-\d+) \|.*\| ([^|]*US-\d{3}[^|]*) \|\s*$', body, flags=re.M):
        owners.update(re.findall(r'US-\d{3}', r.group(2)))
    out = ['# Extrato da API — %s (gerado por _work/build_extracts.py; não é entregável)\n' % title,
           '## Catálogo (api.md §3)\n', body.strip(),
           '\n## Seções das stories donas (Campos, Validações, API, Casos de erro, Eventos, Auditoria)\n']
    for u in sorted(owners):
        if u in stories:
            fn, t, d = stories[u]
            out.append('### %s — %s (`%s`)\n' % (u, t, fn) + '\n'.join('#### %s\n%s\n' % (k, v) for k, v in d.items() if v and k != 'Frontend'))
    io.open('_work/api/%s.md' % slug[num], 'w', encoding='utf-8', newline='\n').write('\n'.join(out))
print('ok: _work/screens/{A,B}.md e _work/api/*.md')
