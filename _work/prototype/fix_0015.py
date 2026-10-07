import io
def rd(p): return io.open(p, encoding='utf-8').read()
def wr(p, s): io.open(p, 'w', encoding='utf-8', newline='\n').write(s)
def fix(p, a, b, n=1):
    s = rd(p)
    if s.count(a) < 1: print('NAO ENCONTRADO', p, a[:60]); return
    wr(p, s.replace(a, b, n)); print('ok', p)
# screens.md: lote 2 a 50 (RN-INBOX-19)
fix('docs/mvp-01/screens.md', '(Idem., lote de 1 a 50)', '(Idem., lote de 2 a 50)')
# processos.html: incluir 0015/2026 (com Ana) na tabela e nos cartões
row = '''          <tr data-row data-tags="comigo unidade" class="hover:bg-slate-50">
            <td class="px-4 py-3"><a href="processo.html" class="font-semibold text-brand-700 hover:underline">0015/2026</a><p class="max-w-xs truncate text-slate-700">Locação de retroescavadeira para obras de drenagem</p><span class="mt-1 inline-block rounded bg-slate-100 px-1.5 py-0.5 text-[11px] text-slate-600">Obras</span></td>
            <td class="px-4 py-3"><span class="inline-flex items-center whitespace-nowrap rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200">Em andamento</span></td>
            <td class="px-4 py-3 text-slate-700">Formalização da demanda</td>
            <td class="px-4 py-3"><p class="text-slate-700">Setor de Manutenção</p><p class="text-xs text-slate-500">Ana Souza</p></td>
            <td class="px-4 py-3"><span class="inline-flex items-center gap-1 whitespace-nowrap text-xs text-slate-700"><i data-lucide="clock" class="h-3.5 w-3.5 text-slate-400"></i>até 24/10</span></td>
            <td class="whitespace-nowrap px-4 py-3 text-right tabular-nums">R$ 126.000,00</td>
            <td class="px-4 py-3"><span class="inline-flex items-center gap-1.5 text-xs"><span class="h-2 w-2 rounded-full bg-sky-500"></span>Média</span></td>
          </tr>
'''
s = rd('prototype/processos.html')
anchor = '        <tbody class="divide-y divide-slate-100">\n'
s = s.replace(anchor, anchor + row, 1)
card = '''    <li data-row data-tags="comigo unidade"><a href="processo.html" class="block rounded-lg border border-slate-200 bg-white p-4 shadow-card">
      <div class="flex items-center justify-between"><span class="font-semibold text-brand-700">0015/2026</span><span class="rounded-full bg-blue-50 px-2 py-0.5 text-xs font-medium text-blue-700 ring-1 ring-inset ring-blue-200">Em andamento</span></div>
      <p class="mt-1 text-sm">Locação de retroescavadeira para obras de drenagem</p>
      <p class="mt-2 text-xs text-slate-500">Formalização da demanda · Setor de Manutenção · Ana Souza</p>
      <p class="mt-1 text-xs text-slate-700">Prazo até 24/10 · R$ 126.000,00</p></a></li>
'''
canchor = '  <ul class="mt-2 space-y-3 md:hidden" data-filter-target="processos">\n'
s = s.replace(canchor, canchor + card, 1)
s = s.replace('<span data-filter-count="processos">10</span>', '<span data-filter-count="processos">11</span>')
s = s.replace('Exportação concluída: 10 processos', 'Exportação concluída: 11 processos').replace('Serão exportados os 10 processos', 'Serão exportados os 11 processos')
wr('prototype/processos.html', s); print('ok processos.html', s.count('0015/2026'))
# painel: contagens com o 0015/2026
p = 'prototype/painel.html'; s = rd(p)
s = s.replace('ring-blue-200">Em andamento</span><span class="font-semibold tabular-nums">4</span>', 'ring-blue-200">Em andamento</span><span class="font-semibold tabular-nums">5</span>', 1)
s = s.replace('<span>1. Formalização da demanda</span><span class="font-semibold tabular-nums">2</span>', '<span>1. Formalização da demanda</span><span class="font-semibold tabular-nums">3</span>', 1)
wr(p, s); print('ok painel')
