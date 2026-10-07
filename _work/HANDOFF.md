# Passagem de sessão — Especificação ContrataFlow (MVP 1)

> **CONCLUÍDO em 2026-10-07 ~09:40** — especificação do MVP 1 completa; card `spec-346` em done; job de retomada apagado. O conteúdo abaixo fica como registro do processo.

> Pasta `_work/` = material de trabalho (não é entregável). Entregável = `docs/`.
> Rastreamento: PRD `prd-1` e card `spec-346` (lane doing) no ddx — registrar notas a cada onda.
> Decisão do usuário (2026-10-06): **opção 1** — subagentes **Sonnet** (`model: "sonnet"`), **no máximo 4 em paralelo**, cada um com **pacote de contexto** do épico e **lotes de 3–4 cards**; o piloto (Opus) revisa com o verificador. Motivo: a leva com 16 subagentes Opus estourou o limite de sessão da conta duas vezes.

## 1. Estado em 2026-10-07 05:45 (3ª sessão — limite de uso atingido ~03:40, renovado 05:20)

| Área | Situação |
|---|---|
| `docs/README.md`, `docs/product/*` (4) | Prontos |
| `docs/architecture/` | Prontos (8/9). **Falta: `authentication.md`** (D01) |
| `docs/adr/` | Pronto: ADR-004. **Faltam: ADR-001, 002, 003, 005..011** (D01–D04) |
| `docs/mvp-01/` | Prontos: overview, epics, features, entities, permissions, events, api (§1–§3), acceptance-criteria (§1–§2), delivery-plan, risks-and-decisions, release-checklist. **Faltam: `tests.md` (D06), `screens.md` (D07–D08), api §4 (D09–D11), acceptance-criteria §3** |
| `docs/backlog/` | **97/114 stories** (verificador OK em todas), **14/19 épicos** (faltam 012, 015, 016, 018, 019), **48/59 features** |

Stories que faltam (17): EP-012 072 · EP-015 084–086 · EP-016 094–098 · EP-018 107–110 · EP-019 111–114.

**Lotes:** concluídos B01–B20, B22–B25, B27, B30, B31; B28 parcial (092/093 ✅). Pendentes: B21, B26, B28 (094/095), B29, B32, B33, B34.

**Lacunas:** `_work/gaps.md` (Onda 3 = 3ª sessão; quase todas resolvidas pelo piloto nas fontes canônicas). Abertas relevantes: precedência de `Process.priority` na aprovação do DFD; seções do template `RISK_MAP` (fechar com B33); justificativa do valor `MANUAL` do TR; recontagem de operações da API (api.md diz 259 — entraram WF-23, DOC-24/25, USR-13, PRS-24…); notificação de quebra do selo de auditoria (MVP 2).

**Ajustes canônicos da 3ª sessão** (detalhe na nota do card `spec-346` e em `_work/gaps.md`): POL-17; POL-09 ampliada (edição, agregados `confidentialExcluded`, anexos de documento `RESTRICTED`); DEC-026 com "Acompanhando"; DEC-027 sem exclusão física no MVP 1; `MovementMetadata` (entities §5.6); `DashboardWidgetKey`; erros `APPROVER_NOT_ELIGIBLE`, `WIDGET_NOT_FOUND`, `STORAGE_QUOTA_EXCEEDED`, `PRIMARY_ORGANIZATION_REQUIRED`; endpoints WF-23, DOC-24/25, USR-13 e rota BFF `forgot-password`; máscaras `PP`/`MR`; `PriceResearch.roundingMode`. Conflitos entre stories corrigidos: US-032×US-022, US-042×US-099, US-056×POL-04/J-08.

**Consumo observado (3ª sessão):** uma janela de uso rendeu **19 lotes** (Sonnet; 155–276 mil tokens por lote — 46 chamadas de ferramenta ≈ 276 mil). Os 4 lotes em voo no limite se perderam (B28 deixou 2 arquivos). Estimativa restante: 7 lotes de stories + ~10 tarefas de documentos + consolidação ≈ **1–2 janelas**. Piloto deve começar sessão nova (contexto enxuto) — o custo do piloto cresce a cada notificação.

## 2. Ferramentas

- `python _work/build_packs.py` → gera `_work/packs/EP-NNN.md` (10–21 mil tokens): regras de escrita, notas de domínio (`_work/notes.md`), estado do épico (stories feitas e **próxima RN**), backlog do épico com nomes de arquivos (stories e features), telas, decisões, entidades, permissões, eventos, API. **Rodar antes de cada lançamento** (atualiza a próxima RN).
- `PYTHONIOENCODING=utf-8 python _work/check_backlog.py [story-0NN ...]` → valida 28 seções na ordem, 8 categorias Gherkin, referências canônicas (argumentos = trechos do nome do arquivo).
- `_work/gen_backlog_index.py` → regenera `docs/backlog/README.md` (⏳ para pendentes).
- `_work/gaps.md` → registro de lacunas por lote.
- `python _work/build_extracts.py` → gera `_work/screens/{A,B}.md` (inventário + seções Frontend das stories) e `_work/api/NN-*.md` (catálogo §3 + seções das stories donas). Rodar antes de lançar D07/D08 e API-1..5. D07/D08 escrevem `_work/screens/screens-{A,B}.md`; o piloto concatena em `docs/mvp-01/screens.md`.

## 3. Procedimento (pool contínuo, ≤ 4 subagentes)

0. **Retomada automática (pedido do usuário em 2026-10-07: "sempre que renovar a sessão, voltar de onde parou automaticamente").** Ao iniciar, rodar `CronList`. Deve existir **exatamente um** job cujo prompt começa com `[Retomada automática — ContrataFlow]`. Se não houver, criar com `CronCreate` (cron `17 * * * *`, recorrente) usando o prompt da §4.4. Os jobs valem só enquanto o Claude Code estiver aberto e expiram em 7 dias; nesse caso, recriar. Ao concluir tudo, apagar o job (`CronDelete`).
   - **Marcar o status na §5 a cada lançamento** (🏃) **e a cada conclusão** (✅ ou ⚠️), para que a retomada saiba o que estava em voo.
   - **Lote 🏃 sem arquivos e sem subagente vivo nesta conversa:** a execução foi perdida no limite de uso. Relançar.
1. `python _work/build_packs.py`.
2. Lançar subagentes (`Agent`, `model: "sonnet"`, `subagent_type: "general-purpose"`, `run_in_background: true`) com os modelos da §4. **Um lote por épico por vez** (a numeração de RN é sequencial no épico); quando um lote termina, a vaga vai para o próximo lote (continuação do mesmo épico, se houver).
3. Ao concluir cada lote: rodar o verificador; ler as lacunas do relatório e resolver as pequenas direto nas fontes canônicas (padrões recorrentes: código de erro novo → api.md §2.2; `NotificationType` → events.md §6; routing key `document.<fato>.<type>` (DEC-162); ação de auditoria → events.md §7; ID de endpoint → api.md §3) e corrigir a story com script Python de substituição; registrar em `_work/gaps.md`.
4. Nota no card `spec-346` a cada 4–6 lotes.

## 4. Modelos de prompt

### 4.1 Lote de stories
```
Você escreve cards de backlog do ContrataFlow (SaaS B2G de contratações públicas — Lei 14.133/2021). Somente documentação Markdown; não escreva código-fonte.
Raiz: C:\Users\luizb\Documents\workspace\ContrataFlow
Leia, nesta ordem: (1) _work/packs/EP-NNN.md — contexto canônico do épico, regras de escrita, notas de domínio e próxima RN; (2) docs/backlog/story-001-create-process.md — referência de formato e qualidade (leia uma vez); (3) docs/backlog/_templates/story-template.md.
Escreva SOMENTE estes arquivos em docs/backlog/ (nomes exatos): <story-0NN-...md, ...>.
Siga rigorosamente o pacote (28 seções na ordem, 8 categorias Gherkin, nomes canônicos, RN continuando a numeração na ordem US-A → US-B → …, tamanho máximo pela estimativa). Coleções de documento tipado seguem a POL-02. Lacunas: use o conceito canônico mais próximo e registre em "Dependências → Lacunas nas fontes canônicas" — antes de declarar lacuna de campo, enum ou evento, confira docs/mvp-01/entities.md ou events.md com grep. Endpoints, notificações ou eventos de outros épicos: procure em docs/mvp-01/api.md ou events.md com grep (não leia os arquivos inteiros). Nunca edite fontes canônicas nem outros arquivos.
Economia: uma chamada Write por arquivo; não releia arquivos grandes; no máximo ~15 chamadas de ferramenta no total.
Ao terminar, rode uma única vez (na raiz): PYTHONIOENCODING=utf-8 python _work/check_backlog.py story-0NN ... — e corrija com Edit o que for apontado.
Responda só com (máx. 15 linhas): arquivos (linhas), lacunas (com proposta), suposições.
```

### 4.2 Stories + épico + features (último lote do épico)
Mesmo texto da 4.1, dividido em "Parte A — stories" e "Parte B — épico e features (depois da Parte A)": "Das stories já existentes do épico (<lista>) leia só o front matter e as seções 'Descrição', 'Regras de negócio' e 'Dependências' (grep/sed). Escreva docs/backlog/epic-NNN-<slug>.md e feature-0NN-<slug>.md (nomes exatos do pacote §2), seguindo os templates (ler também epic-template.md e feature-template.md). Pontos: XS=1, S=2, M=5, L=8, XL=13. Título do épico = nome em docs/mvp-01/epics.md; não use identificadores provisórios como PEND-XX."
Nomes dos épicos: epic-001-process, 002-dfd, 003-etp, 004-price-research, 005-risk-map, 006-term-of-reference, 007-workflow, 008-routing, 009-task-inbox, 010-timeline, 011-documents, 012-comments, 013-audit, 014-dashboard, 015-technical-foundation, 016-identity-access, 017-tenancy-organization, 018-document-templates, 019-notifications.

### 4.4 Prompt do job de retomada automática (CronCreate `17 * * * *`)
```
[Retomada automática — ContrataFlow] Verificação horária.
1) Se nesta conversa houver subagentes do pool ainda em execução (lançados e sem aviso de conclusão ou falha), não faça nada: responda só "Em andamento." sem usar ferramentas.
2) Caso contrário, retome a especificação do ContrataFlow conforme _work/HANDOFF.md (§3): rode build_packs, relance os lotes ⚠️ ou 🏃 sem arquivos e mantenha o pool de até 4 subagentes Sonnet.
3) Se todos os lotes e tarefas estiverem concluídos, siga para a consolidação (§6). Ao terminar tudo, apague este job (CronList + CronDelete).
```

### 4.3 Documentos
Mesmo cabeçalho; indicar arquivos a ler (decisions.md seções específicas + docs relacionados) e o arquivo a escrever. ADRs: Título; Status; Data; Decisores; Contexto; Decisão; Alternativas (prós/contras/motivo); Consequências; Riscos e mitigação; Critérios de revisão; Referências (DEC-xxx). Referência de formato: docs/adr/adr-004-outbox-events.md (87 linhas). Nomes: adr-001-modular-monolith, 002-multi-tenancy, 003-authentication, 005-workflow-engine, 006-document-model, 007-pdf-generation, 008-configurable-rules, 009-audit-trail, 010-shared-validation, 011-identifiers-numbering (títulos em decisions.md §11).

### 4.5 API §4 (API-1..5) — modelo usado em API-1
```
Você escreve a especificação detalhada da API do ContrataFlow (…). Somente Markdown em pt-BR (schemas em TS resumido e JSON curto aceitos).
Leia: (1) docs/mvp-01/api.md linhas 1–220 (§1–§2; não repetir, só referenciar); (2) extratos _work/api/<NN-slug>.md da tarefa (fonte principal, leitura única); (3) só se faltar tipo, grep em entities.md.
Escreva SOMENTE: docs/mvp-01/api/<NN-slug>.md (…).
Cada arquivo: "# <título da seção>"; "> Parte de [api.md §4](../api.md#4-especificação-por-endpoint). Convenções e erros genéricos: api.md §1–§2."; tabela-resumo; uma subseção por endpoint, na ordem do catálogo, todos sem exceção:
### <ID> — <ação>  ·  `MÉTODO /api/v1/rota` · **Permissão:** … · **Story:** US-…
- **Cabeçalhos** · **Parâmetros** · **Request** · **Response** · **Erros** (HTTP · code · quando) · **Efeitos** (eventos, auditoria, notificações, timeline) · **Notas** (RN-xxx, limites)
Regras: não inventar; faltou → "a definir na implementação" e listar na resposta. Incluir as notas herdadas do item da tabela §5.
Economia: uma Write por arquivo; ≤ ~10 chamadas. Resposta ≤ 10 linhas: arquivos (linhas, nº de endpoints) e lacunas.
```

## 5. Plano de lotes (status)

| Lote | Épico | Arquivos | Status |
|---|---|---|---|
| B01 | EP-001 | US-009, 010, 011 | ✅ |
| B02 | EP-001 | US-012, 013 + epic-001 + FT-001…007 | ✅ |
| B03 | EP-002 | US-017, 018 + epic-002 + FT-008…010 | ✅ |
| B04 | EP-003 | US-019, 020, 021 | ✅ |
| B05 | EP-003 | US-022, 023 + epic-003 + FT-011…014 | ✅ |
| B06 | EP-004 | US-025, 026, 027, 028 | ✅ |
| B07 | EP-004 | US-029, 030, 031, 032 | ✅ |
| B08 | EP-004 | epic-004 + FT-015…020 (4.2 só Parte B) | ✅ |
| B09 | EP-005 | US-033, 034, 035 + epic-005 + FT-021…023 | ✅ |
| B10 | EP-006 | US-037, 038, 039 + epic-006 + FT-024…027 | ✅ |
| B11 | EP-007 | US-041, 042, 043 | ✅ |
| B12 | EP-007 | US-044, 045, 046 + epic-007 + FT-028…030 | ✅ |
| B13 | EP-008 | US-048, 049, 050, 051 | ✅ |
| B14 | EP-008 | US-052, 053, 054, 055 | ✅ |
| B15 | EP-008 | epic-008 + FT-031…035 (4.2 só Parte B) | ✅ |
| B16 | EP-009 | US-056, 057, 058 + epic-009 + FT-036 | ✅ |
| B17 | EP-010 | US-059, 060 + epic-010 + FT-037 | ✅ |
| B18 | EP-011 | US-062, 063, 064, 065 | ✅ |
| B19 | EP-011 | US-066, 067, 068 | ✅ |
| B20 | EP-011 | US-069, 070 + epic-011 + FT-038…042 | ✅ |
| B21 | EP-012 | US-072 + epic-012 + FT-043 | ✅ |
| B22 | EP-013 | US-073, 074, 075 + epic-013 + FT-044, FT-045 | ✅ |
| B23 | EP-014 | US-076 + epic-014 + FT-046 | ✅ |
| B24 | EP-015 | US-078, 079, 080 | ✅ |
| B25 | EP-015 | US-081, 082, 083 | ✅ |
| B26 | EP-015 | US-084, 085, 086 + epic-015 + FT-047…050 | ✅ |
| B27 | EP-016 | US-089, 090, 091 | ✅ |
| B28 | EP-016 | US-092, 093, 094, 095 | ✅ |
| B29 | EP-016 | US-096, 097, 098 + epic-016 + FT-051…054 | ✅ |
| B30 | EP-017 | US-101, 102, 103 | ✅ |
| B31 | EP-017 | US-104, 105, 106 + epic-017 + FT-055…057 | ✅ |
| B32 | EP-018 | US-107, 108, 109 | ✅ |
| B33 | EP-018 | US-110 + epic-018 + FT-058 | ✅ |
| B34 | EP-019 | US-111, 112, 113, 114 + epic-019 + FT-059 | ✅ |

Tarefas de documentos:

| Tarefa | Arquivos | Fontes principais | Status |
|---|---|---|---|
| D01 | `docs/architecture/authentication.md` + ADR-003 | decisions §7 (DEC-130..140), permissions.md, api.md (rotas do BFF, inclusive `forgot-password`), stories US-087/088/089/090 (MFA, `USR-13` mfa-reset)/091 (convite) | ✅ |
| D02 | ADR-001, ADR-002, ADR-005 | DEC-040/041, DEC-080..082, DEC-014..016; architecture.md, multi-tenancy.md | ✅ |
| D03 | ADR-006, ADR-007, ADR-008 | DEC-017..019, DEC-060, DEC-016; storage.md | ✅ |
| D04 | ADR-009, ADR-010, ADR-011 | DEC-025/084/085, DEC-054, DEC-002/028; queues.md | ✅ |
| D05 | Revisão de `domains.md` | DEC-015, DEC-018, DEC-022 | ✅ (sem mudanças) |
| D06 | `docs/mvp-01/tests.md` | acceptance-criteria.md (CA-T e J-01..J-10), delivery-plan, permissions §10, features.md | ✅ |
| D07–D08 | `docs/mvp-01/screens.md` (A: SCR-001..015, 101..106, 111, 113, 115, 116; B: SCR-029..041, 107..110, 112, 114 — o piloto concatena) | features.md Apêndice A + seções Frontend das stories (grep) — depois das stories. Registrar componentes transversais sem SCR própria: `AttachmentUploader`/`AttachmentList` (US-068), diálogo de sigilo em SCR-006 (US-013) | ✅ (`docs/mvp-01/screens.md` montado) |
| API-1 | `docs/mvp-01/api/01-session-me.md`, `02-processes.md` (47 endpoints) | `_work/api/01-*.md`, `02-*.md` (extratos: catálogo §3 + Campos/Validações/API/Erros/Eventos/Auditoria das stories donas) | ✅ |
| API-2 | `03-documents.md`, `04-templates.md` (42) | `_work/api/03-*.md`, `04-*.md` | ✅ |
| API-3 | `05-dfd.md` … `09-term-of-reference.md` (60) | `_work/api/05..09-*.md` | ✅ |
| API-4 | `10-workflow.md` … `13-dashboard-notifications-audit.md` (55) | `_work/api/10..13-*.md` | ✅ |
| API-5 | `14-tenant-administration.md`, `15-platform-health.md` (65) | `_work/api/14-*.md`, `15-*.md` | ✅ |
| API-idx | api.md §4 vira índice dos 15 arquivos (piloto) | — | ✅ |

Notas herdadas da antiga D09–D11 (incluir nos arquivos) — **versão completa**: detalhe por endpoint de todas as operações (decisão do usuário em 2026-10-07: não enxugar). Incluir: prévia de `PRC-08` por transição (US-047 lacuna 2: `departmentResolution`, `requiresComment`, `allowDueDateOverride`, `dueAtPreview`, `approverPreview`, motivos de indisponibilidade); `etpChangedSinceImport` e `importToken` no TRM (US-037); resposta de comparação de versões `DOC-18` (US-066: diffs por `header`/`sections`/`collections`, marcadores `ADDED`/`REMOVED`/`CHANGED`/`UNCHANGED`/`MASKED`)

## 6. Consolidação final (piloto)

**Andamento:** todos os passos concluídos em 2026-10-07 ~09:40 (API-5 entregue: 269/269 endpoints em `docs/mvp-01/api/`; `check_links.py` sem quebras reais; rótulo M4/J-03 alinhado a DEC-015; card `spec-346` encerrado; job de retomada apagado).

1. Verificador em todas as stories (114/114 OK) e conferência de épicos/features (tabelas coerentes com features.md).
2. Regerar `docs/backlog/README.md` e o índice da §3 de `acceptance-criteria.md` (contagem de cenários por categoria por story).
3. Incorporar lacunas restantes de `_work/gaps.md` às fontes canônicas e a `risks-and-decisions.md` (inclui: runbooks RB-06..09 "(a criar)" de observability.md no release-checklist; reativação de perfil fora do MVP 1; notificação de quebra do selo de auditoria no MVP 2; itens "(proposta)" remanescentes em storage.md/observability.md; acesso de suporte DEC-139 sem story no MVP 1; lacunas L-01..L-18 do roadmap; recontagem de operações da API em api.md e overview.md).
4. Atualizar `docs/mvp-01/overview.md` (números) e links quebrados (`grep -o '](.*\.md' …`).
5. Encerrar o card `spec-346` (move done com resumo) e registrar memória do projeto (dcoder-memory: página do ContrataFlow com estrutura e decisões-chave).
6. Apresentar ao usuário a proposta de sequência de implementação (já em `docs/mvp-01/delivery-plan.md` §5).
