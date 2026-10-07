# Regenera o índice da §3 de docs/mvp-01/acceptance-criteria.md (contagem de cenários Gherkin por categoria por story).
import io, re, glob, os
cats = ['Sucesso', 'Validação', 'Permissão', 'Tenant incorreto', 'Duplicidade', 'Concorrência', 'Falha de banco', 'Falha de integração']
rows, tot = [], {c: 0 for c in cats}
for f in sorted(glob.glob('docs/backlog/story-*.md')):
    s = io.open(f, encoding='utf-8').read()
    sid = 'US-' + os.path.basename(f)[6:9]
    t = re.search(r'^title:\s*"?(.*?)"?\s*$', s, flags=re.M)
    ep = re.search(r'^epic:\s*(EP-\d+)', s, flags=re.M)
    pr = re.search(r'^priority:\s*(P\d)', s, flags=re.M)
    cnt = {c: 0 for c in cats}
    for m in re.finditer(r'Scenario(?: Outline)?: \[([^\]]+)\]', s):
        if m.group(1) in cnt: cnt[m.group(1)] += 1
    for c in cats: tot[c] += cnt[c]
    rows.append('| [%s](../backlog/%s) | %s | %s | %s | %s | %d |' % (sid, os.path.basename(f), (t.group(1) if t else ''), ep.group(1) if ep else '', pr.group(1) if pr else '',
                ' | '.join(str(cnt[c]) for c in cats), sum(cnt.values())))
head = '| Story | Título | Épico | Prior. | ' + ' | '.join(cats) + ' | Total |\n|' + '---|' * (len(cats) + 5)
total = '| **Total** | %d stories | | | %s | **%d** |' % (len(rows), ' | '.join('**%d**' % tot[c] for c in cats), sum(tot.values()))
table = head + '\n' + '\n'.join(rows) + '\n' + total
p = 'docs/mvp-01/acceptance-criteria.md'
s = io.open(p, encoding='utf-8').read()
marker = '<!-- INDICE-POR-STORY -->'
i = s.index(marker) + len(marker)
s = s[:i] + '\n\n' + table + '\n'
io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
print('índice: %d stories, %d cenários' % (len(rows), sum(tot.values())))
