import io
def fix(p, a, b):
    s = io.open(p, encoding='utf-8').read()
    if a not in s:
        print('NAO ENCONTRADO', p, a[:60]); return
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(a, b)); print('ok', p)
fix('docs/mvp-01/overview.md',
    'Ao final do MVP 1, um órgão público consegue conduzir **toda a fase preparatória** de uma contratação (Lei 14.133/2021, art. 18) dentro da plataforma:',
    'Ao final do MVP 1, um órgão público consegue conduzir **todo o planejamento da contratação** (artefatos do art. 18 da Lei 14.133/2021) dentro da plataforma; dotação, minuta do edital, parecer jurídico e controle interno completam a fase preparatória no MVP 2 (DEC-015):')
fix('docs/mvp-01/overview.md', '| Processos da fase preparatória conduzidos na plataforma |', '| Processos com o planejamento da contratação conduzido na plataforma |')
fix('docs/mvp-01/overview.md', '| Tempo médio da fase preparatória |', '| Tempo médio do planejamento da contratação |')
fix('docs/mvp-01/release-checklist.md', '(jornada completa da fase preparatória)', '(jornadas J-01..J-10: planejamento da contratação completo)')
