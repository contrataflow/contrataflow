# Registra as decisões de sprint 0 (PEND-01, 04, 06, 10, 15 — opção padrão confirmada em 2026-10-07) e atualiza as referências.
import io, re, glob


def rd(p):
    return io.open(p, encoding='utf-8').read()


def wr(p, s):
    io.open(p, 'w', encoding='utf-8', newline='\n').write(s)


def sub1(s, a, b, p):
    if a not in s:
        print('NAO ENCONTRADO', p, '::', a[:70])
        return s
    return s.replace(a, b)


NOTE = ("\n**Decididas em 2026-10-07 (sprint 0 — padrão confirmado pelo produto):** PEND-01 → DEC-028 · PEND-04 → DEC-020 · "
        "PEND-06 → DEC-141 · PEND-10 → DEC-061 · PEND-15 → DEC-021.\n")
PENDS = ['PEND-01', 'PEND-04', 'PEND-06', 'PEND-10', 'PEND-15']

# --- decisions.md
p = 'docs/architecture/decisions.md'
s = rd(p)
s = sub1(s, "- Outliers são **sinalizados**, nunca excluídos automaticamente; exclusão exige justificativa e é auditada.",
         "- Outliers são **sinalizados**, nunca excluídos automaticamente; exclusão exige justificativa e é auditada.\n"
         "- **Padrão do produto (confirmado em 2026-10-07 — PEND-04 encerrada):** método `AUTO_CV` (média se CV ≤ 25%, mediana se CV > 25%); "
         "sinalização abaixo de 70% e acima de 130% da mediana das demais cotações; mínimo de 3 cotações (IN SEGES/ME 65/2021, art. 6º).", p)
s = sub1(s, "Escalas (padrão 5×5) e faixas de nível configuráveis (PEND-15).",
         "Escalas e faixas de nível configuráveis por tenant (`risk.scale`, `risk.levelThresholds`); padrão confirmado em 2026-10-07 "
         "(PEND-15 encerrada): 5×5, faixas 1–4 Baixo, 5–9 Médio, 10–16 Alto, 17–25 Extremo.", p)
s = sub1(s, "`numbering.process.assignOn` (PEND-01).",
         "`numbering.process.assignOn`; padrão `CREATE` confirmado pelo produto em 2026-10-07 (PEND-01 encerrada).", p)
DEC061 = ("### DEC-061 — CI/CD com GitHub Actions · `Aceita`\n"
          "Código no GitHub e CI/CD com GitHub Actions: estágios obrigatórios para *merge*, proteção de branch e ambientes `staging`/`production` "
          "com aprovação ([architecture.md §4.5](architecture.md), US-079). Decidido em 2026-10-07 (PEND-10 encerrada).\n\n")
s = sub1(s, "---\n\n## 5. Dados e persistência", DEC061 + "---\n\n## 5. Dados e persistência", p)
DEC141 = ("### DEC-141 — Domínio único da aplicação · `Aceita`\n"
          "A aplicação web e o BFF respondem em **um único domínio por ambiente**, com seleção de órgão/instituição após o login (DEC-012); "
          "não há subdomínio por tenant no MVP 1. Motivos: identidade global com vínculos em vários tenants e troca sem novo login (US-093), "
          "cookie `__Host-` (DEC-131), um único endereço de retorno no Authentik e um único certificado. Domínio próprio por tenant pode ser "
          "avaliado como recurso comercial a partir do MVP 2 (os slugs reservados da US-099 já o preveem). Decidido em 2026-10-07 (PEND-06 encerrada).\n\n")
s = sub1(s, "---\n\n## 8. Eventos, filas e jobs", DEC141 + "---\n\n## 8. Eventos, filas e jobs", p)
for pid in PENDS:
    s, k = re.subn(r'^\| ' + pid + r' \|.*\n', '', s, flags=re.M)
    if k != 1:
        print('linha §10', pid, k)
s = re.sub(r'^(\| PEND-19 \|.*\|)$', lambda m: m.group(1) + '\n' + NOTE, s, count=1, flags=re.M)
wr(p, s)

# --- risks-and-decisions.md
p = 'docs/mvp-01/risks-and-decisions.md'
s = rd(p)
for pid in PENDS:
    s, k = re.subn(r'^\| ' + pid + r' \|.*\n', '', s, flags=re.M)
    if k != 1:
        print('linha §8', pid, k)
s = re.sub(r'^(\| PEND-19 \|.*\|)$', lambda m: m.group(1) + '\n' + NOTE, s, count=1, flags=re.M)
s = sub1(s, "faixas de outlier configuráveis (PEND-04)", "faixas de outlier configuráveis (DEC-020)", p)
wr(p, s)

# --- delivery-plan e roadmap
p = 'docs/mvp-01/delivery-plan.md'
s = rd(p)
s, k = re.subn(r"^Decisões pendentes que \*\*precisam\*\* ser fechadas na Sprint 0 \(bloqueiam implementação\): PEND-01 \(momento da numeração\), "
               r"PEND-04 \(método e faixas da pesquisa de preços\), PEND-06 \(URL por tenant\), PEND-10 \(provedor de CI\), PEND-15 \(escala de risco\)\.",
               lambda m: ("Decisões de sprint 0 (bloqueavam a implementação) **fechadas em 2026-10-07** com os padrões adotados: PEND-01 → DEC-028 "
                          "(numeração na criação), PEND-04 → DEC-020 (método `AUTO_CV`, faixas 70%/130%), PEND-06 → DEC-141 (domínio único), "
                          "PEND-10 → DEC-061 (GitHub Actions), PEND-15 → DEC-021 (escala 5×5)."), s, flags=re.M)
if k != 1:
    print('delivery-plan linha 22', k)
s = sub1(s, "| 0 | Preparação | Decisões PEND críticas;", "| 0 | Preparação | Decisões PEND críticas (já fechadas em 2026-10-07);", p)
wr(p, s)
p = 'docs/product/roadmap.md'
s = rd(p)
s = sub1(s, "pendências críticas fechadas — PEND-01, PEND-04, PEND-06, PEND-10 e PEND-15 —,",
         "pendências críticas fechadas — PEND-01, PEND-04, PEND-06, PEND-10 e PEND-15 (✅ fechadas em 2026-10-07: DEC-028, DEC-020, DEC-141, DEC-061, DEC-021) —,", p)
wr(p, s)

# --- ADR-011
p = 'docs/adr/adr-011-identifiers-numbering.md'
s = rd(p)
rules = [
    (r"^7\. \*\*Momento de atribuição configurável, ainda em aberto:\*\*.*$",
     "7. **Momento de atribuição configurável:** `numbering.process.assignOn` é `CREATE` (padrão confirmado pelo produto em 2026-10-07 — PEND-01 encerrada, DEC-028) ou `START`/autuação; a numeração em si (esta ADR) suporta os dois momentos."),
    (r"^- PEND-01 \(momento de atribuição\) ainda aberto é risco de retrabalho.*$",
     "- Tenants que preferirem numerar na autuação mudam `numbering.process.assignOn` para `START`, sem mudança de esquema."),
    (r"^\| PEND-01 mudar após o MVP 1 assumir `CREATE` como padrão \|", "| Piloto preferir numerar na autuação (`START`) |"),
    (r"^- Decisão de produto sobre PEND-01 \(momento de atribuição do número do processo\) for fechada\.$",
     "- A maioria dos tenants passar a usar `START`, indicando que o padrão do produto deve mudar."),
]
for a, b in rules:
    s, k = re.subn(a, lambda m, b=b: b, s, flags=re.M)
    if k != 1:
        print('ADR-011', a[:40], k)
wr(p, s)

# --- épicos e stories (redação específica)
specific = [
    ('docs/backlog/epic-001-process.md', r"^- PEND-01 — Numeração na criação × autuação \(padrão adotado: `CREATE`, configurável; decidir até Sprint 0\)$",
     "- ~~PEND-01~~ — decidida em 2026-10-07: numeração na criação (`CREATE`) como padrão, configurável para `START` (DEC-028)."),
    ('docs/backlog/epic-005-risk-map.md', r"^- PEND-15 — Escala de risco configurável \(dimensão e faixas\) além do padrão 5×5 semeado\.$",
     "- ~~PEND-15~~ — decidida em 2026-10-07: padrão 5×5 semeado (DEC-021); escala e faixas configuráveis por tenant."),
    ('docs/backlog/epic-017-tenancy-organization.md', r"^- PEND-01 — Momento de atribuição do número do processo \(`CREATE` vs\. `START`\) como padrão definitivo do produto\.$",
     "- ~~PEND-01~~ — decidida em 2026-10-07: `CREATE` como padrão (DEC-028), configurável para `START`."),
    ('docs/backlog/epic-017-tenancy-organization.md', r"^- PEND-06 — Lista de slugs reservados de tenant, a revisar quando subdomínios próprios forem implementados\.$",
     "- Lista de slugs reservados de tenant: revisar se domínios próprios por tenant forem adotados (MVP 2+; no MVP 1, domínio único — DEC-141)."),
    ('docs/backlog/story-079-ci-pipeline.md', r"^- PEND-10 \(provedor de CI/CD\) já está decidido: \*\*GitHub Actions\*\* \(`decisions\.md`\)\.",
     "- Provedor de CI/CD decidido: **GitHub Actions** (DEC-061)."),
    ('docs/backlog/story-079-ci-pipeline.md', r"PEND-10 \(resolvido: GitHub Actions\)", "DEC-061"),
    ('docs/backlog/story-077-monorepo-setup.md', r"^- PEND-10 decidido \(GitHub Actions\); proteção de branch é configurada na US-079\.$",
     "- CI/CD decidido: GitHub Actions (DEC-061); proteção de branch é configurada na US-079."),
    ('docs/backlog/story-099-tenant-provisioning.md', r"\(subdomínios futuros — PEND-06\)", "(reserva para eventuais domínios próprios por tenant — DEC-141)"),
]
for p, a, b in specific:
    s = rd(p)
    s2, k = re.subn(a, lambda m, b=b: b, s, flags=re.M)
    if k == 0:
        print('NAO ENCONTRADO', p, '::', a[:60])
    wr(p, s2)

# --- substituições genéricas em docs/
pairs = [('DEC-020, PEND-04', 'DEC-020'), ('DEC-020; PEND-04', 'DEC-020'), ('DEC-021; PEND-15', 'DEC-021'), ('DEC-021, PEND-15', 'DEC-021'),
         ('DEC-028, PEND-01', 'DEC-028'), ('IN SEGES/ME 65/2021; PEND-04', 'IN SEGES/ME 65/2021; DEC-020'),
         ('PEND-06, PEND-07, PEND-17', 'DEC-141, PEND-07, PEND-17'), ('DT-07, PEND-06, PEND-17', 'DT-07, DEC-141, PEND-17'),
         ('PEND-06, PEND-18', 'DEC-141, PEND-18'), ('(PEND-06):', '(DEC-141):'),
         ('(GitHub Actions, PEND-10)', '(GitHub Actions, DEC-061)'), ('(GitHub Actions — PEND-10)', '(GitHub Actions — DEC-061)'),
         ('DEC-137; PEND-10; ADR-001', 'DEC-137, DEC-061; ADR-001'),
         ('| PEND-01 |', '| DEC-028 |'), ('| PEND-04 |', '| DEC-020 |'), ('| PEND-15 |', '| DEC-021 |'),
         ('configurável, PEND-15)', 'configurável, DEC-021)'), ('padrão 5×5, PEND-15)', 'padrão 5×5, DEC-021)'),
         ('(PEND-15)', '(DEC-021)')]
for p in glob.glob('docs/**/*.md', recursive=True):
    s = rd(p)
    o = s
    for a, b in pairs:
        s = s.replace(a, b)
    if s != o:
        wr(p, s)

# --- relatório de remanescentes
left = []
for p in glob.glob('docs/**/*.md', recursive=True):
    for i, l in enumerate(rd(p).splitlines(), 1):
        if (re.search(r'PEND-(01|04|06|10|15)\b', l) and 'Decididas em 2026-10-07' not in l and 'encerrada' not in l
                and '~~PEND' not in l and 'fechadas em 2026-10-07' not in l):
            left.append('%s:%d: %s' % (p, i, l.strip()[:150]))
print('remanescentes:', len(left))
print('\n'.join(left[:25]))
