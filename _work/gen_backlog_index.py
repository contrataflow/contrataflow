# -*- coding: utf-8 -*-
"""Regera docs/backlog/README.md a partir de docs/mvp-01/features.md. Uso: python _work/gen_backlog_index.py"""
import re, io, os
from collections import Counter
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'docs/mvp-01/features.md'), encoding='utf-8').read()
epics = re.findall(r'^\| (EP-\d{3}) \| ([^|]+?) \| `([A-Z]+)` \| `(epic-[^`]+)` \|$', src, re.M)
features = re.findall(r'^\| (FT-\d{3}) ([^|]+?) \| ([^|]+?) \| `(feature-[^`]+)` \|$', src, re.M)
stories = re.findall(r'^\| (US-\d{3}) \| ([^|]+?) \| (FT-\d{3}) \| (P\d) \| (XS|S|M|L|XL) \| ([^|]*?) \| `(story-[^`]+)` \|$', src, re.M)
pts = {'XS': 1, 'S': 2, 'M': 5, 'L': 8, 'XL': 13}
feat_epic, cur = {}, None
for line in src.splitlines():
    m = re.match(r'^## (EP-\d{3}) ', line)
    if m: cur = m.group(1)
    m = re.match(r'^\| (FT-\d{3}) ', line)
    if m and cur: feat_epic.setdefault(m.group(1), cur)
exists = lambda f: os.path.exists(os.path.join(ROOT, 'docs/backlog', f))
mark = lambda f: '' if exists(f) else ' ⏳'
out = io.StringIO(); w = out.write
w('# Backlog — Índice\n\n')
w('> Índice navegável dos cards. Fonte canônica de IDs, prioridades, estimativas e dependências: [`../mvp-01/features.md`](../mvp-01/features.md). Modelos: [`_templates/`](_templates/). Exemplo de referência: [US-001](story-001-create-process.md).\n')
w('> Cada story segue o padrão de card de 28 seções com critérios de aceite em Gherkin (8 categorias de cenário). ⏳ = card ainda não escrito.\n\n')
w('## Convenções\n\n- Arquivos: `epic-NNN-slug.md`, `feature-NNN-slug.md`, `story-NNN-slug.md` (numeração global e contínua entre MVPs).\n- Front matter YAML de cada card: `id`, `epic`, `feature`, `priority`, `estimate`, `depends_on`, `screens`, `endpoints`, `permissions`, `events`.\n- Estimativa: XS = 1 · S = 2 · M = 5 · L = 8 · XL = 13 pontos.\n\n')
w('## Épicos\n\n| Épico | Título | Área RN | Stories | Pontos |\n|---|---|---|---|---|\n')
for eid, title, area, f in epics:
    sts = [s for s in stories if feat_epic.get(s[2]) == eid]
    w(f'| [{eid}]({f}){mark(f)} | {title.strip()} | `{area}` | {len(sts)} | {sum(pts[s[4]] for s in sts)} |\n')
tot = sum(pts[s[4]] for s in stories)
w(f'| **Total** | | | **{len(stories)}** | **{tot}** |\n\n## Features\n\n| Feature | Título | Épico | Stories |\n|---|---|---|---|\n')
for fid, ftitle, _, ffile in features:
    w(f'| [{fid}]({ffile}){mark(ffile)} | {ftitle.strip()} | {feat_epic.get(fid, "")} | {", ".join(s[0] for s in stories if s[2] == fid)} |\n')
w('\n## Stories\n\n| Story | Título | Épico | Feature | Prio | Est | Depende de |\n|---|---|---|---|---|---|---|\n')
for sid, title, fid, prio, est, deps, sfile in stories:
    w(f'| [{sid}]({sfile}){mark(sfile)} | {title.strip()} | {feat_epic.get(fid, "")} | {fid} | {prio} | {est} | {deps.strip()} |\n')
c = Counter(s[3] for s in stories); done = sum(exists(s[6]) for s in stories)
w(f'\nTotais: {len(epics)} épicos · {len(features)} features · {len(stories)} stories ({done} escritas) · P0 {c["P0"]} · P1 {c["P1"]} · P2 {c["P2"]} · {tot} pontos.\n')
open(os.path.join(ROOT, 'docs/backlog/README.md'), 'w', encoding='utf-8').write(out.getvalue())
print(f'{done}/{len(stories)} stories escritas; índice regenerado')
