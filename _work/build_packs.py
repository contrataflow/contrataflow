# -*- coding: utf-8 -*-
"""Gera pacotes de contexto por épico (_work/packs/EP-NNN.md) a partir das fontes canônicas.
Rodar antes de cada onda de subagentes:  python _work/build_packs.py
Cada pacote traz só os trechos relevantes (decisões, entidades, permissões, eventos, API, telas)
+ regras de escrita + estado atual do épico (stories já escritas e próximo número de RN)."""
import re, os, glob

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
D = os.path.join(ROOT, 'docs')
OUT = os.path.join(ROOT, '_work', 'packs')
os.makedirs(OUT, exist_ok=True)
rd = lambda p: open(os.path.join(D, p), encoding='utf-8').read()
DEC, ENT, PERM, EV, API, FEAT = (rd('architecture/decisions.md'), rd('mvp-01/entities.md'), rd('mvp-01/permissions.md'),
                                 rd('mvp-01/events.md'), rd('mvp-01/api.md'), rd('mvp-01/features.md'))

def cut(text, start_pat, stop_pat=r'^(#{1,4} |---\s*$)'):
    m = re.search(start_pat, text, re.M)
    if not m: return ''
    rest = text[m.end():]
    s = re.search(stop_pat, rest, re.M)
    return text[m.start(): m.end() + (s.start() if s else len(rest))].rstrip() + '\n'

def section(text, heading_regex):
    """Seção inteira (inclui subníveis) a partir de um heading até o próximo heading de mesmo nível ou superior."""
    m = re.search(heading_regex, text, re.M)
    if not m: return ''
    level = len(re.match(r'#+', m.group(0)).group(0))
    rest = text[m.end():]
    s = re.search(rf'^#{{1,{level}}} ', rest, re.M)
    return text[m.start(): m.end() + (s.start() if s else len(rest))].rstrip() + '\n'

def rows(text, pred):
    return '\n'.join(l for l in text.splitlines() if l.startswith('|') and pred(l))

def table_header(text, first_cell):
    for i, l in enumerate(text.splitlines()):
        if l.startswith('| ' + first_cell):
            lines = text.splitlines()
            return lines[i] + '\n' + lines[i + 1]
    return ''

RULES = """## 0. Regras de escrita (obrigatórias)
- pt-BR; identificadores técnicos em inglês **exatamente** como neste pacote (fontes canônicas). Se precisar de algo inexistente, use o conceito mais próximo e registre em "Dependências → Lacunas nas fontes canônicas" + no relatório final. Nunca edite fontes canônicas.
- Formato: copie o front matter e as **28 seções H2, nesta ordem** de `docs/backlog/_templates/story-template.md`: Título, Descrição, Contexto, Objetivo, Persona, Pré-condições, Fluxo principal, Fluxos alternativos, Regras de negócio, Campos, Validações, Permissões, Eventos gerados, Notificações, Critérios de aceite em Gherkin, Casos de erro, Dependências, Impacto técnico, Backend, Frontend, Banco de dados, API, Logs, Auditoria, Testes necessários, Definition of Done, Estimativa, Prioridade. H1 = `# US-NNN — <Título>`. Sem o comentário do template.
- Gherkin (bloco ```gherkin, palavras-chave em inglês, texto pt-BR) com cenários marcados **[Sucesso] [Validação] [Permissão] [Tenant incorreto] [Duplicidade] [Concorrência] [Falha de banco] [Falha de integração]** — todas as 8 em toda story (adapte o sentido quando necessário).
- Regras de negócio `RN-<ÁREA>-NN` continuando a numeração indicada em "Estado do épico".
- Referência de qualidade e formato: `docs/backlog/story-001-create-process.md` (leia uma vez). Tamanho máximo: L ≤ 420 linhas, M ≤ 300, S/XS ≤ 200.
- Erros: códigos de api.md §2 (por campo em `errors[].code` §2.1.1; violações em `violations[]` §2.1.2). Endpoints sempre pelo ID do catálogo (ex.: PRC-19) + rota.
- Economia: escreva cada arquivo em **uma única chamada Write**; não releia arquivos grandes; sem scripts de verificação longos.
- Ao final, responda só com: arquivos escritos (linhas), lacunas encontradas (com proposta), suposições relevantes.
"""

COMMON_DECS = [1, 3, 10, 13, 17, 18, 24]   # sempre úteis
EPICS = {
 'EP-001': dict(area='PROC', decs=[23,28,29,30,31,32,33,34,36,55,57,104,105,106,180,181,182,183], ents=['Process','ProcessItem','ProcessParticipant','Tag','ProcessTag','ProcessStage','ProcessAssignment','ProcessMovement','ProcessAccess','SavedView'], json=['5.4','5.6'], settings=['process.','access.','numbering.process','labels.'], perms=['PROCESS_','TAG_'], pols=['01','05','06','07','08','09','10'], psec=['## 4.','## 5.'], ev=['process.'], api=['PRC','TAG'], audit=['Processo']),
 'EP-002': dict(area='DFD', decs=[19,29,32,56,182,15,16], ents=['Dfd','Document','DocumentVersion','DocumentItem','ProcessItem','DocumentTemplateVersion'], json=['5.1','5.3'], settings=['numbering.document'], perms=['DFD_','DOCUMENT_','ATTACHMENT_'], pols=['01','02','09','11'], psec=[], ev=['document.'], api=['DFD','DOC','PRC-14','PRC-19','ATT-02'], audit=['Documentos']),
 'EP-003': dict(area='ETP', decs=[16,19,20,32,56,182], ents=['Etp','EtpAlternative','Document','DocumentVersion','DocumentItem','PriceResearch'], json=['5.1','5.3'], settings=[], perms=['ETP_','DOCUMENT_'], pols=['02','09','11'], psec=[], ev=['document.','etp.'], api=['ETP','DOC'], audit=['Documentos','Tipados']),
 'EP-004': dict(area='PRICE', decs=[19,20,30,86], ents=['PriceResearch','PriceItem','PriceSource','Quotation','Supplier','ProcessItem','Document'], json=['5.9'], settings=['priceResearch.'], perms=['PRICE_RESEARCH_','SUPPLIER_','PROCESS_VIEW_CONFIDENTIAL'], pols=['02','09'], psec=[], ev=['price_research.','supplier.','document.'], api=['PRS','SUP','ATT-02'], audit=['Tipados','Colaboração']),
 'EP-005': dict(area='RISK', decs=[21], ents=['Risk','RiskTreatment','Document','CatalogItem'], json=[], settings=['risk.'], perms=['RISK_'], pols=['02'], psec=[], ev=['risk.','document.'], api=['RSK','DOC'], audit=['Tipados']),
 'EP-006': dict(area='TR', decs=[19,20,30,56,182], ents=['TermOfReference','DocumentItem','Etp','Document','DocumentTemplateVersion'], json=['5.1','5.3','5.8'], settings=[], perms=['TERM_','DOCUMENT_'], pols=['02','09','11'], psec=[], ev=['term.','document.'], api=['TRM','DOC'], audit=['Tipados','Documentos']),
 'EP-007': dict(area='WF', decs=[14,15,16,22,31,84], ents=['Workflow','WorkflowVersion','WorkflowStage','WorkflowTransition','WorkflowRule','ProcessStage'], json=['5.4','5.5'], settings=[], perms=['WORKFLOW_'], pols=[], psec=[], ev=['workflow.'], api=['WF','PRC-08','PRC-09'], audit=['Configuração']),
 'EP-008': dict(area='TRAM', decs=[14,15,16,22,23,31,55,104,105], ents=['ProcessStage','ProcessAssignment','ProcessMovement','ProcessAccess','Approval','ApprovalDocument','Document'], json=['5.6'], settings=['approval.','deadlines.','calendar.'], perms=['PROCESS_FORWARD','PROCESS_RETURN','PROCESS_CLAIM','PROCESS_ASSIGN','APPROVAL_'], pols=['01','03','04','05'], psec=['## 5.','## 7.'], ev=['process.','approval.'], api=['PRC-10','PRC-11','PRC-19','PRC-20','PRC-21','PRC-22','APV','CAL-06','DOC-09','DOC-11'], audit=['Processo','Aprovação']),
 'EP-009': dict(area='INBOX', decs=[22,26,31], ents=['ProcessStage','ProcessAssignment','Approval','ProcessParticipant'], json=[], settings=['deadlines.'], perms=['INBOX_','APPROVAL_VIEW','PROCESS_CLAIM','PROCESS_ASSIGN'], pols=['03','04','05'], psec=['## 5.','## 7.'], ev=['process.assigned','approval.'], api=['TSK','APV-01'], audit=['Processo']),
 'EP-010': dict(area='TML', decs=[25,161], ents=['ProcessTimelineEntry'], json=[], settings=[], perms=['PROCESS_VIEW'], pols=['09'], psec=[], ev=['§5'], api=['PRC-12'], audit=[]),
 'EP-011': dict(area='DOC', decs=[19,30,34,56,60,84,136], ents=['DocumentType','DocumentTemplate','DocumentTemplateVersion','Document','DocumentVersion','DocumentRendition','DocumentItem','Attachment'], json=['5.1','5.2','5.3','5.7'], settings=['uploads.','numbering.document'], perms=['DOCUMENT_','ATTACHMENT_'], pols=['02','09','11'], psec=[], ev=['document.','attachment.'], api=['DOC','DTY','ATT'], audit=['Documentos','Colaboração']),
 'EP-012': dict(area='CMT', decs=[25], ents=['Comment','Mention'], json=[], settings=[], perms=['COMMENT_'], pols=[], psec=['## 5.'], ev=['comment.'], api=['CMT'], audit=['Colaboração']),
 'EP-013': dict(area='AUD', decs=[25,84,85,138,161], ents=['AuditLog','AuditSeal'], json=[], settings=[], perms=['AUDIT_'], pols=[], psec=[], ev=['§7'], api=['AUD'], audit=['*']),
 'EP-014': dict(area='DASH', decs=[26,30,180], ents=['Process','ProcessStage','Approval'], json=[], settings=['deadlines.'], perms=['DASHBOARD_','PROCESS_VIEW'], pols=['09'], psec=['## 5.'], ev=[], api=['DSH','TSK-02'], audit=[]),
 'EP-015': dict(area='FND', decs=[2,40,41]+list(range(50,61))+list(range(80,87))+list(range(100,109))+list(range(130,140))+list(range(160,165)), ents=['OutboxEvent'], json=[], settings=['features.'], perms=['PLATFORM_'], pols=[], psec=['## 1.','## 9.'], ev=['§2','§3'], api=['HLT'], audit=[]),
 'EP-016': dict(area='IAM', decs=[12,35,53,130,131,132,133,134,135,137,138,139,140], ents=['User','TenantMembership','MembershipDepartment','Permission','Role','RolePermission','RoleAssignment'], json=[], settings=['security.'], perms=['*'], pols=['*'], psec=['*'], ev=['membership.','role.'], api=['ME','USR','ROL'], audit=['Autenticação','Identidade']),
 'EP-017': dict(area='TEN', decs=[11,27,28,31,59,80,81,82,83,132,139], ents=['Tenant','TenantSetting','Organization','Department','CatalogItem','Holiday','NumberSequence'], json=['5.9'], settings=['*'], perms=['ORGANIZATION_','DEPARTMENT_','CATALOG_','CALENDAR_','SETTINGS_','PLATFORM_'], pols=['12'], psec=[], ev=['tenant.','organization.','department.','catalog.'], api=['PLT','ORG','DEP','SET','CAT','CAL'], audit=['Plataforma','Configuração']),
 'EP-018': dict(area='TPL', decs=[16,56,60], ents=['DocumentType','DocumentTemplate','DocumentTemplateVersion'], json=['5.1','5.2','5.8'], settings=[], perms=['TEMPLATE_','DOCUMENT_TYPE_'], pols=[], psec=[], ev=['template.','document_type.'], api=['TPL','DTY'], audit=['Configuração']),
 'EP-019': dict(area='NTF', decs=[138,161,163], ents=['Notification','NotificationPreference'], json=[], settings=['notifications.'], perms=[], pols=[], psec=[], ev=['§6'], api=['NTF','ME-05','ME-06'], audit=['Identidade']),
}

# mapa história -> épico a partir do features.md
feat_epic, cur = {}, None
for l in FEAT.splitlines():
    m = re.match(r'^## (EP-\d{3}) ', l)
    if m: cur = m.group(1)
    m = re.match(r'^\| (FT-\d{3}) ', l)
    if m and cur: feat_epic.setdefault(m.group(1), cur)
story_rows = re.findall(r'^(\| (US-\d{3}) \| [^|]+ \| (FT-\d{3}) \|.*)$', FEAT, re.M)

existing = {}
for f in glob.glob(os.path.join(D, 'backlog', 'story-*.md')):
    s = open(f, encoding='utf-8').read()
    m = re.search(r'^epic: (EP-\d{3})', s, re.M)
    if m: existing.setdefault(m.group(1), []).append((os.path.basename(f), s))

for ep, cfg in EPICS.items():
    out = [f'# Pacote de contexto — {ep}\n', '> Gerado por `_work/build_packs.py` a partir das fontes canônicas. Não editar à mão.\n', RULES]
    # estado do épico
    area = cfg['area']; files = sorted(existing.get(ep, []))
    nums = [int(n) for _, s in files for n in re.findall(rf'RN-{area}-(\d+)', s)]
    nxt = (max(nums) + 1) if nums else 1
    out.append(f"## 1. Estado do épico\n- Área de RN: `{area}` — **próxima regra: RN-{area}-{nxt:02d}**\n- Stories já escritas: {', '.join(n for n, _ in files) or 'nenhuma'}\n- Épico/feature files existentes: {', '.join(sorted(os.path.basename(x) for x in glob.glob(os.path.join(D,'backlog', f'epic-{ep[3:]}-*.md')))) or 'nenhum'}\n")
    # backlog do épico
    sts = [r for r in story_rows if feat_epic.get(r[2]) == ep]
    ft_rows = [l for l in FEAT.splitlines() if re.match(r'^\| FT-\d{3} ', l) and feat_epic.get(l[2:8]) == ep]
    out.append('## 2. Backlog do épico (features.md)\n' + table_header(FEAT, 'Feature |') + '\n' + '\n'.join(ft_rows) + '\n\n' + table_header(FEAT, 'Story |') + '\n' + '\n'.join(r[0] for r in sts) + '\n')
    ids = {r[1] for r in sts}
    scr = [l for l in FEAT.splitlines() if re.match(r'^\| SCR-\d{3} ', l) and ids & set(re.findall(r'US-\d{3}', l))]
    out.append('### Telas relacionadas\n' + table_header(FEAT, 'ID | Tela') + '\n' + '\n'.join(scr) + '\n')
    # decisões
    decs = sorted(set(COMMON_DECS + cfg['decs']))
    out.append('## 3. Decisões (decisions.md)\n' + '\n'.join(cut(DEC, rf'^### DEC-{d:03d} ', r'^(### |## |---\s*$)') for d in decs))
    # entidades
    out.append('## 4. Entidades (entities.md)\n' + cut(ENT, r'^### 1\.1 Colunas padrão', r'^### 1\.2') + section(ENT, r'^## 2\. Enums'))
    for e in cfg['ents']:
        out.append(section(ENT, rf'^#### {e} \('))
    for j in cfg['json']:
        out.append(section(ENT, rf'^### {re.escape(j)} '))
    if cfg['settings']:
        hdr = table_header(ENT, 'Chave |')
        sel = rows(section(ENT, r'^## 6\. Registro'), lambda l: cfg['settings'] == ['*'] or any(f'`{p}' in l for p in cfg['settings']))
        out.append('### Configurações do tenant relevantes (§6)\n' + hdr + '\n' + sel + '\n')
    if ep in ('EP-017', 'EP-015', 'EP-002', 'EP-018'):
        out.append(section(ENT, r'^## 7\. Dados semeados'))
    # permissões
    if cfg['psec'] == ['*']:
        out.append('## 5. Permissões (permissions.md completo)\n' + PERM)
    else:
        sel = rows(PERM, lambda l: re.match(r'^\| `([A-Z_]+)`', l) and any(l.startswith(f'| `{p}') for p in cfg['perms']))
        out.append('## 5. Permissões (recorte de permissions.md)\n' + table_header(PERM, 'Código |') + '\n' + sel + '\n')
        if cfg['pols']:
            out.append('### Políticas\n' + table_header(PERM, 'ID | Política') + '\n' + rows(PERM, lambda l: any(l.startswith(f'| POL-{p} ') for p in cfg['pols'])) + '\n')
        for ps in cfg['psec']:
            out.append(section(PERM, rf'^{re.escape(ps)}'))
    # eventos
    evp = []
    for k in cfg['ev']:
        if k.startswith('§'):
            evp.append(section(EV, rf'^## {k[1:]}\. '))
        else:
            evp.append(rows(EV, lambda l, k=k: f'`{k}' in l))
    if evp:
        out.append('## 6. Eventos (recorte de events.md)\n' + section(EV, r'^## 2\. Envelope').split('```json')[0] + '\n'.join(evp) + '\n')
    if cfg['audit']:
        aud = rows(section(EV, r'^## 7\. '), lambda l: cfg['audit'] == ['*'] or any(l.startswith(f'| {a}') for a in cfg['audit']))
        out.append('### Ações de auditoria\n| Área | Ações |\n|---|---|\n' + aud + '\n')
    # API
    out.append('## 7. API (api.md)\n' + section(API, r'^## 1\. Convenções') + section(API, r'^## 2\. Erros'))
    sel = rows(section(API, r'^## 3\. '), lambda l: any(l.startswith(f'| {p}') for p in cfg['api']))
    out.append('### Endpoints do épico (catálogo §3)\n| # | Método | Rota | Perm. | Sucesso | Eventos | Story |\n|---|---|---|---|---|---|---|\n' + sel + '\n')
    notes_path = os.path.join(ROOT, '_work', 'notes.md')
    if os.path.exists(notes_path):
        nsec = section(open(notes_path, encoding='utf-8').read(), rf'^## {ep}\s*$')
        if nsec:
            out.insert(3, '## Notas de domínio do épico (seguir, detalhando)\n' + nsec.split('\n', 1)[1])
    text = '\n'.join(out)
    open(os.path.join(OUT, f'{ep}.md'), 'w', encoding='utf-8').write(text)
    print(f'{ep}: {len(text)//4:>6} tokens aprox. | stories feitas {len(files):>2}/{len(sts)} | próxima RN-{area}-{nxt:02d}')
