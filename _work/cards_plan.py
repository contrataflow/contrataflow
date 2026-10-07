# Plano de criação dos cards de implementação (um por story) em camadas topológicas.
# Saída: uma linha por story — camada | US | título | épico/feature | prioridade/estimativa | sprint | dependências
import io, re, glob, os, json

stories = {}
for f in sorted(glob.glob('docs/backlog/story-*.md')):
    s = io.open(f, encoding='utf-8').read()
    fm = s.split('---')[1]
    g = lambda k: (re.search(r'^' + k + r':\s*(.*)$', fm, flags=re.M) or [None, ''])[1].strip()
    deps = re.findall(r'US-\d{3}', g('depends_on'))
    stories[g('id')] = dict(file=os.path.basename(f), title=g('title').strip('"'), epic=g('epic'), feature=g('feature'),
                            priority=g('priority'), estimate=g('estimate'), deps=deps,
                            screens=re.findall(r'SCR-\d{3}', g('screens')), endpoints=re.findall(r'[A-Z]+-\d+', g('endpoints')))
# sprint pelo delivery-plan §5
dp = io.open('docs/mvp-01/delivery-plan.md', encoding='utf-8').read()
sec = dp[dp.index('## 5. Proposta de sequência'):dp.index('## 6. Marcos')]
sprint = {}
for r in re.finditer(r'^\| (\d+) \| [^|]+ \| ([^|]+) \|', sec, flags=re.M):
    for u in re.findall(r'US-\d{3}', r.group(2)):
        sprint[u] = int(r.group(1))
# raízes passam a depender de US-077 (monorepo) para garantir a ordem de execução
for u, d in stories.items():
    if u != 'US-077' and not d['deps']:
        d['deps'] = ['US-077']
        d['root'] = True
# dependências inexistentes ou ciclos
missing = [(u, x) for u, d in stories.items() for x in d['deps'] if x not in stories]
layer, done = {}, set()
level = 0
while len(done) < len(stories):
    cur = [u for u, d in stories.items() if u not in done and all(x in done for x in d['deps'])]
    if not cur:
        print('CICLO:', sorted(set(stories) - done)); break
    for u in cur: layer[u] = level
    done |= set(cur); level += 1
print('stories', len(stories), 'camadas', level, 'deps inexistentes', missing, 'sem sprint', sorted(u for u in stories if u not in sprint))
for L in range(level):
    us = sorted(u for u in stories if layer.get(u) == L)
    print('--- camada', L, len(us))
    for u in us:
        d = stories[u]
        print('%s|%s|%s/%s|%s/%s|S%s|%s|%s' % (u, d['title'], d['epic'], d['feature'], d['priority'], d['estimate'],
              sprint.get(u, '-'), ','.join(d['deps']), d['file']))
json.dump({u: dict(d, layer=layer.get(u), sprint=sprint.get(u)) for u, d in stories.items()},
          io.open('_work/cards_plan.json', 'w', encoding='utf-8'), ensure_ascii=False, indent=0)
