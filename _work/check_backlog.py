import re, sys, glob, os, json
root = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'docs')
rd = lambda p: open(os.path.join(root,p), encoding='utf-8').read()
perm_src, ev_src, api_src, feat_src, ent_src, dec_src = rd('mvp-01/permissions.md'), rd('mvp-01/events.md'), rd('mvp-01/api.md'), rd('mvp-01/features.md'), rd('mvp-01/entities.md'), rd('architecture/decisions.md')

perms = set(re.findall(r'^\| `([A-Z_]+)` \|', perm_src, re.M)) | {'PLATFORM_TENANT_MANAGE','PLATFORM_SUPPORT_ACCESS','PLATFORM_QUEUE_ADMIN','PLATFORM_AUDIT_VIEW'}
pols = set(re.findall(r'\| (POL-\d\d) \|', perm_src))
events = set(re.findall(r'`([A-Z][A-Za-z]+)`', ev_src))
endpoints = set(re.findall(r'^\| ([A-Z]{2,3}-\d\d) \|', api_src, re.M))
errcodes = set(re.findall(r'^\| `([A-Z_]+)` \| \d{3} \|', api_src, re.M)) | set(re.findall(r'^\| `([A-Z_]+)`(?: / `([A-Z_]+)`)? \| [A-Z]', api_src, re.M) and [x for t in re.findall(r'^\| `([A-Z_]+)`(?: / `([A-Z_]+)`)? \|', api_src, re.M) for x in t if x]) | {'NOT_FOUND'}
enum_vals = set(v for row in re.findall(r'^\| `[A-Za-z]+`(?: \*\(registro\)\*)? \| (.+?) \|$', ent_src, re.M) for v in re.findall(r'`([A-Z_]+)`', row))
errcodes |= enum_vals
screens = set(re.findall(r'^\| (SCR-\d{3}) \|', feat_src, re.M))
stories = set(re.findall(r'^\| (US-\d{3}) \|', feat_src, re.M))
decs = set(re.findall(r'### (DEC-\d{3})', dec_src)) ; pends = set(re.findall(r'\| (PEND-\d\d) \|', dec_src))
settings = set(re.findall(r'^\| `([a-z][A-Za-z]+\.[A-Za-z.<>]+)` \|', ent_src, re.M))
audit_actions = set(re.findall(r'`([a-z_]+\.[a-z_]+)`', ev_src))
notif_types = set(re.findall(r'^\| `([A-Z_]+)` \| `?[A-Z]', ev_src, re.M))

canon_tokens = set(re.findall(r'`([A-Z][A-Z0-9_]{2,})`', dec_src+ent_src+perm_src+ev_src+api_src+feat_src))
canon_tokens |= set(re.findall(r'code = "([A-Z][A-Z0-9_]{2,})"', api_src))
errcodes |= canon_tokens
events |= set(re.findall(r'`([A-Z][a-zA-Z]+)`', dec_src))
SECTIONS = ['Título','Descrição','Contexto','Objetivo','Persona','Pré-condições','Fluxo principal','Fluxos alternativos','Regras de negócio','Campos','Validações','Permissões','Eventos gerados','Notificações','Critérios de aceite em Gherkin','Casos de erro','Dependências','Impacto técnico','Backend','Frontend','Banco de dados','API','Logs','Auditoria','Testes necessários','Definition of Done','Estimativa','Prioridade']
CATS = ['[Sucesso]','[Validação]','[Permissão]','[Tenant incorreto]','[Duplicidade]','[Concorrência]','[Falha de banco]','[Falha de integração]']

files = sorted(glob.glob(os.path.join(root,'backlog','story-*.md')))
if len(sys.argv) > 1: files = [f for f in files if any(a in f for a in sys.argv[1:])]
report = {}
for f in files:
    s = open(f, encoding='utf-8').read(); name = os.path.basename(f); issues = []
    m = re.match(r'story-(\d{3})-', name); sid = f'US-{m.group(1)}'
    if not s.startswith('---'): issues.append('sem front matter')
    if not re.search(rf'^id: {sid}\s*$', s, re.M): issues.append('front matter id divergente')
    if not re.search(rf'^# {sid} — ', s, re.M): issues.append('H1 fora do padrão')
    h2 = re.findall(r'^## (.+?)\s*$', s, re.M)
    if h2 != SECTIONS:
        missing = [x for x in SECTIONS if x not in h2]; extra = [x for x in h2 if x not in SECTIONS]
        issues.append(f'seções: faltando={missing} extras={extra} ordem_ok={[x for x in h2 if x in SECTIONS]==[x for x in SECTIONS if x in h2]}')
    g = re.search(r'```gherkin(.*?)```', s, re.S)
    if not g: issues.append('sem bloco gherkin')
    else:
        miss = [c for c in CATS if c not in g.group(1)]
        if miss: issues.append(f'categorias Gherkin faltando: {miss}')
    if '<!--' in s and 'REGRAS DO PADRÃO' in s: issues.append('comentário do template não removido')
    unk = lambda found, known: sorted(set(found) - known)
    allowed_dyn = lambda c: c.endswith('_NOT_FOUND') or c.startswith(('DFD_','ETP_','TR_','PRICE_','RISK_','SECTION_','FIELD_')) or '_MAX' in c
    p = unk(re.findall(r'`((?:PROCESS|DOCUMENT|DFD|ETP|PRICE_RESEARCH|RISK|TERM|TAG|ATTACHMENT|SUPPLIER|TEMPLATE|WORKFLOW|APPROVAL|COMMENT|INBOX|DASHBOARD|AUDIT|USER|ROLE|ORGANIZATION|DEPARTMENT|CATALOG|CALENDAR|SETTINGS|PLATFORM)_[A-Z_]+)`', s), perms | errcodes | notif_types)
    p = [c for c in p if not allowed_dyn(c)]
    if p: issues.append(f'permissões/códigos desconhecidos: {p}')
    e = unk(re.findall(r'\b(US-\d{3})\b', s), stories);  e and issues.append(f'stories inexistentes: {e}')
    e = unk(re.findall(r'\b(SCR-\d{3})\b', s), screens); e and issues.append(f'telas inexistentes: {e}')
    e = unk(re.findall(r'(?<![A-Z]-)(?<!RN-)(?<!V-)\b((?:ME|PRC|TAG|DOC|DTY|TPL|DFD|ETP|PRS|SUP|RSK|TRM|WF|APV|TSK|CMT|ATT|DSH|NTF|AUD|USR|ROL|ORG|DEP|SET|CAT|CAL|PLT|HLT)-\d\d)\b', s), endpoints); e and issues.append(f'endpoints inexistentes: {e}')
    e = unk(re.findall(r'\b(DEC-\d{3})\b', s), decs); e and issues.append(f'DEC inexistentes: {e}')
    e = unk(re.findall(r'\b(POL-\d\d)\b', s), pols); e and issues.append(f'POL inexistentes: {e}')
    e = unk(re.findall(r'\b(PEND-\d\d)\b', s), pends); e and issues.append(f'PEND inexistentes: {e}')
    ev = unk(re.findall(r'`((?:Process|Document|Approval|Dfd|DFD|ETP|Etp|PriceResearch|Quotation|Risk|Term|Comment|User|Attachment|Workflow|Template|Catalog|Holiday|Supplier|Membership|Role|Tenant|Organization|Department)[A-Za-z]*(?:ed|ted|Changed|Completed|Created|Approved|Assigned|Mentioned|Uploaded|Rejected|Deleted|Removed|Added|Moved|Returned|Withdrawn|Ready|Failed|Overdue|Soon|Invited|Provisioned|Activated|Suspended|Reactivated|Revoked|Expired|Published|Retired|Recalculated|Restored|Excluded|Recommended|Assessed|Discarded|Duplicated|Forwarded|Resumed|Canceled|Finalized|Submitted|Reopened|Reassigned))`', s), events)
    ev and issues.append(f'eventos desconhecidos: {ev}')
    report[sid] = {'linhas': s.count('\n'), 'issues': issues}
ok = sum(1 for v in report.values() if not v['issues'])
for k,v in report.items():
    flag = 'OK ' if not v['issues'] else 'ERR'
    print(f"{flag} {k} ({v['linhas']} linhas)" + ('' if not v['issues'] else '\n    - ' + '\n    - '.join(v['issues'])))
print(f'\n{ok}/{len(report)} stories sem problemas')
