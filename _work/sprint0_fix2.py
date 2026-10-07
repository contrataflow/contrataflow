import io
def fix(p, a, b):
    s = io.open(p, encoding='utf-8').read()
    if a not in s:
        print('NAO ENCONTRADO', p, a[:50]); return
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s.replace(a, b)); print('ok', p)
fix('docs/backlog/story-079-ci-pipeline.md', '(sua pré-condição citava: "PEND-10 decidido; proteção de branch é configurada na US-079")', '(sua pré-condição citava: "CI/CD decidido — DEC-061; proteção de branch é configurada na US-079")')
fix('docs/product/product-overview.md', 'parâmetros padrão (DEC-020, PEND-15)', 'parâmetros padrão (DEC-020, DEC-021)')
fix('docs/product/product-overview.md', 'numeração (PEND-01);', 'numeração (DEC-028);')
fix('docs/product/terminology.md', '(e a PEND-06 fala em "seleção de órgão")', '(e a DEC-141 fala em "seleção de órgão")')
fix('docs/product/terminology.md', '| DEC-002; DEC-028; PEND-01 |', '| DEC-002; DEC-028 |')
