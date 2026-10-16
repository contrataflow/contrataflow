---
id: US-060
title: "Visualizar timeline com filtros"
epic: EP-010
feature: FT-037
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-059]
modules: [timeline]
screens: [SCR-006]
endpoints: [PRC-12]
permissions: [PROCESS_VIEW, PROCESS_VIEW_CONFIDENTIAL_BUDGET]
events: []
---

# US-060 — Visualizar timeline com filtros

## Título
Visualizar timeline com filtros

## Descrição
**Como** qualquer pessoa que visualize o processo, **quero** consultar a timeline do processo com filtros por grupo, autor e período, agrupada por dia, **para** entender rapidamente o que aconteceu sem precisar abrir tramitações, documentos e aprovações separadamente.

A aba "Timeline" de SCR-006 lista, mais recente primeiro, as entradas gravadas pelo `TimelineProjector` (US-059) via `PRC-12`, paginadas por cursor. O frontend agrupa visualmente as entradas por dia (fuso do tenant) e renderiza a mensagem de cada uma a partir de `type` + `params`, usando o mesmo dicionário do registro `TimelineEntryType`. Entradas `BUDGET_RESTRICTED` só aparecem para quem atende POL-09.

## Contexto
- DEC-025 define a timeline como a narrativa de processo visível a quem vê o processo (sem exigir `AUDIT_VIEW`), em contraste com a auditoria técnica.
- SCR-006 (painel do processo) já reserva a aba "Timeline" entre Resumo, Documentos, Itens, Tramitação, Comentários e Participantes (mvp-01/features.md, Apêndice A).
- Esta story é somente leitura: depende de US-059 para que existam entradas a exibir; não grava nada em `process_timeline_entries`.

## Objetivo
Permitir que qualquer usuário autorizado abra a aba "Timeline" e encontre o evento procurado com poucos filtros (grupo, autor, período), com p95 do endpoint `PRC-12` abaixo de 300 ms e sem jamais expor entradas orçamentárias sigilosas a quem não tem permissão (POL-09).

## Persona
- **Principal:** qualquer persona com `PROCESS_VIEW` sobre o processo (Requisitante, Gestor de Contratações, Autoridade, Planejamento, Controle Interno).
- **Secundárias:** perfis com `PROCESS_VIEW_CONFIDENTIAL_BUDGET` ou custódia atual do processo — únicos que veem entradas `BUDGET_RESTRICTED`.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Processo visível ao usuário (DEC-024).
- Existem entradas de timeline geradas pelo projetor síncrono (US-059).

## Fluxo principal
1. O usuário abre SCR-006 (`/processos/[id]`) e seleciona a aba **"Timeline"**.
2. O front chama `PRC-12` (`GET /processes/{id}/timeline?limit=50`) sem filtros; exibe skeleton até os dados chegarem.
3. A API autoriza `PROCESS_VIEW` no escopo do processo (DEC-024); se não visível, responde 404.
4. A API consulta `process_timeline_entries` do processo, ordenadas por `occurredAt DESC, id DESC`, descartando entradas `BUDGET_RESTRICTED` para quem não atende POL-09, e retorna até `limit` itens com `meta.nextCursor`/`hasMore`.
5. O front agrupa as entradas por dia no fuso do tenant (rótulos "Hoje", "Ontem" ou data completa), renderiza a mensagem de cada entrada a partir de `type` + `params` e exibe o nome do ator (ou "Sistema" quando `actorType = SYSTEM`).
6. O usuário aplica filtros de **grupo**, **autor** e/ou **período**; o front reenvia `PRC-12` com os parâmetros e reinicia a paginação.
7. Ao rolar até o fim da página carregada, o front busca a próxima página com o `cursor` retornado (scroll infinito) até `hasMore = false`.

## Fluxos alternativos
- **FA-01 — Sem entradas:** estado vazio "Nenhum evento registrado ainda."
- **FA-02 — Filtro sem resultados:** "Nenhum evento encontrado para os filtros selecionados." com botão "Limpar filtros".
- **FA-03 — Entrada orçamentária sigilosa oculta:** quem não atende POL-09 simplesmente não vê a entrada `BUDGET_RESTRICTED`, sem indicação de que algo foi ocultado (para não revelar a existência do dado sigiloso).
- **FA-04 — Navegação a partir de uma entrada:** clique em uma entrada do tipo `COMMENT_ADDED` navega até o comentário na aba "Comentários", quando aplicável.
- **FA-05 — Processo sem acesso do usuário:** 404 (DEC-024); a aba "Timeline" nem é exibida, pois o carregamento do processo já teria bloqueado antes.

## Regras de negócio
- **RN-TML-09** — `PRC-12` pagina por cursor opaco (`occurredAt`, `id`), página padrão 50, máx. 100 (api.md §1.2); ordenação fixa, mais recente primeiro, na direção do índice de entities.md §4.10.
- **RN-TML-10** — Filtro por período (`occurredFrom`/`occurredTo`, inclusivos, análogo à convenção genérica `createdFrom`/`createdTo` de api.md §1.2 aplicada a `occurredAt`); `occurredFrom` posterior a `occurredTo` é inválido.
- **RN-TML-11** — Filtro por autor (`actorId`, um ou mais valores, combinados por OU); as opções oferecidas na UI são os atores já presentes na timeline carregada do processo, sem endpoint de busca dedicado.
- **RN-TML-12** — Filtro por grupo (`group`, um ou mais valores, combinados por OU), conforme o mapeamento de apresentação abaixo (não é coluna no banco; agrupa os valores de `TimelineEntryType` definidos na RN-TML-02 de US-059):

| Grupo | `type` incluídos |
|---|---|
| `PROCESSO` | `PROCESS_CREATED`, `PROCESS_DUPLICATED_FROM`, `PROCESS_UPDATED`, `PROCESS_NUMBER_ASSIGNED`, `ITEMS_CHANGED`, `PROCESS_SUSPENDED`, `PROCESS_RESUMED`, `PROCESS_CANCELED`, `PROCESS_COMPLETED`, `CONFIDENTIALITY_CHANGED`, `PARTICIPANT_ADDED`, `PARTICIPANT_REMOVED` |
| `TRAMITACAO` | `PROCESS_FORWARDED`, `PROCESS_RETURNED`, `PROCESS_STAGE_CHANGED`, `PROCESS_CLAIMED`, `PROCESS_ASSIGNED`, `STAGE_OVERDUE` |
| `DOCUMENTOS` | `DOCUMENT_CREATED`, `DOCUMENT_VERSION_CREATED`, `DOCUMENT_SUBMITTED`, `DOCUMENT_FINALIZED`, `DOCUMENT_APPROVED`, `DOCUMENT_RETURNED`, `DOCUMENT_REJECTED`, `DOCUMENT_REOPENED`, `DOCUMENT_CANCELED`, `DOCUMENT_WITHDRAWN`, `ETP_ALTERNATIVE_RECOMMENDED`, `QUOTATION_EXCLUDED`, `QUOTATION_RESTORED`, `RISK_ADDED`, `RISK_LEVEL_CHANGED`, `RISK_REMOVED`, `TERM_IMPORTED_FROM_ETP` |
| `APROVACOES` | `APPROVAL_REQUESTED`, `APPROVAL_DECIDED`, `APPROVAL_CANCELED`, `APPROVAL_REASSIGNED` |
| `COMENTARIOS` | `COMMENT_ADDED`, `COMMENT_REMOVED`, `ATTACHMENT_ADDED`, `ATTACHMENT_REMOVED` |

- **RN-TML-13** — Entradas com `visibility = BUDGET_RESTRICTED` são omitidas da resposta (e da paginação) para quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo e não detém a custódia atual (POL-09); para os demais, aparecem normalmente.
- **RN-TML-14** — A mensagem em pt-BR é renderizada no frontend a partir de `type` + `params`, usando o mesmo dicionário do registro `TimelineEntryType` (events.md §5); a API nunca retorna mensagem pré-formatada.
- **RN-TML-15** — Agrupamento visual por dia no fuso do tenant (DEC-003); rótulos relativos "Hoje"/"Ontem" e data completa para os demais dias.
- **RN-TML-16** — Meta de performance: p95 de `PRC-12` < 300 ms para páginas de até 50 itens, usando o índice `(tenant_id, process_id, occurred_at DESC, id DESC)`.

## Campos
Parâmetros de consulta de `PRC-12` (não há formulário de escrita):

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Grupo | `group` | multisseleção | Não | valores da tabela da RN-TML-12 | todos |
| Autor | `actorId` | multisseleção | Não | ids de atores presentes na timeline | todos |
| Período – de | `occurredFrom` | data/hora (ISO 8601 UTC) | Não | ≤ `occurredTo` | — |
| Período – até | `occurredTo` | data/hora (ISO 8601 UTC) | Não | ≥ `occurredFrom` | — |
| *(sistema)* Cursor | `cursor` | string opaca | Não | token da página anterior | — |
| *(sistema)* Limite | `limit` | número | Não | 1–100 | 50 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `occurredFrom` posterior a `occurredTo` | Front + API | "O período final deve ser igual ou posterior ao inicial." | `VALIDATION_ERROR` (`OUT_OF_RANGE` em `occurredTo`) |
| V-02 | `cursor` inválido ou corrompido | API | "Não foi possível continuar a listagem. Role novamente desde o início." | `VALIDATION_ERROR` (`INVALID_FORMAT` em `cursor`) |
| V-03 | `limit` fora de 1–100 | Front + API | — (front normaliza antes de enviar) | `VALIDATION_ERROR` (`OUT_OF_RANGE` em `limit`) |
| V-04 | `group` com valor fora da tabela da RN-TML-12 | API | "Filtro de grupo inválido." | `VALIDATION_ERROR` (`INVALID_ENUM` em `group`) |

## Permissões
- **Permissão:** `PROCESS_VIEW` cobrindo o processo (DEC-024); leitura, sem política de escopo adicional para entradas `STANDARD`.
- **Políticas:** POL-09 — entradas `BUDGET_RESTRICTED` exigem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` cobrindo o processo ou custódia atual (RN-TML-13).
- **MFA:** não exigido (leitura, risco `L`).
- **Sem permissão:** processo não visível → 404 (DEC-024); a aba "Timeline" nem é renderizada em SCR-006 (bloqueio ocorre no carregamento do processo).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Leitura; nenhum evento de domínio é publicado por esta story. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Visualizar timeline com filtros

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" possui entradas de timeline de tipos variados
    And o usuário "Ana" tem "PROCESS_VIEW" sobre o processo "0012/2026"

  Scenario: [Sucesso] Listar a timeline agrupada por dia
    When "Ana" abrir a aba "Timeline" do processo "0012/2026"
    Then a API "GET /api/v1/processes/{id}/timeline" deve responder 200 com até 50 entradas
    And o front deve agrupar as entradas por dia no fuso "America/Sao_Paulo"
    And cada entrada deve exibir a mensagem renderizada a partir de "type" e "params"

  Scenario: [Sucesso] Filtrar por grupo, autor e período
    When "Ana" filtrar por grupo "APROVACOES", autor "Carlos" e período dos últimos 7 dias
    Then a API deve responder 200 apenas com entradas do grupo "APROVACOES", ator "Carlos" e "occurredAt" nos últimos 7 dias
    And o "meta.nextCursor" deve permitir continuar a paginação dentro do mesmo filtro

  Scenario: [Validação] Período inválido
    When "Ana" informar "occurredFrom" posterior a "occurredTo"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "occurredTo"
    And a listagem não deve ser alterada

  Scenario: [Permissão] Entradas orçamentárias sigilosas ficam ocultas
    Given que o processo "0012/2026" é orçamento sigiloso e tem uma entrada "PROCESS_UPDATED" com visibilidade "BUDGET_RESTRICTED"
    And "Ana" não possui "PROCESS_VIEW_CONFIDENTIAL_BUDGET" nem custódia atual do processo
    When "Ana" listar a timeline
    Then a entrada "PROCESS_UPDATED" sigilosa não deve aparecer na resposta
    And a paginação deve considerar apenas as entradas visíveis a "Ana"

  Scenario: [Permissão] Usuário sem PROCESS_VIEW não acessa a timeline
    Given que o usuário "Bruno" não possui "PROCESS_VIEW" sobre o processo "0012/2026"
    When "Bruno" chamar "GET /api/v1/processes/{id}/timeline"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"

  Scenario: [Tenant incorreto] Processo de outro tenant
    Given que o processo "0007/2026" pertence ao tenant "Prefeitura B"
    When "Ana", autenticada na "Prefeitura de São José", chamar a timeline do processo "0007/2026"
    Then a API deve responder 404 com código "PROCESS_NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Repetir a mesma página não altera o resultado
    Given que "Ana" obteve uma página cujo "meta.nextCursor" é "C1"
    When a mesma requisição da primeira página for repetida sem avançar o cursor
    Then a API deve devolver o mesmo conjunto de entradas e o mesmo "nextCursor"
    And nenhuma entrada deve aparecer duplicada entre as chamadas

  Scenario: [Concorrência] Nova entrada é projetada durante a rolagem
    Given que "Ana" está rolando a timeline com paginação por cursor
    When uma nova entrada for projetada pelo "TimelineProjector" (US-059) entre duas chamadas de página
    Then a nova entrada deve aparecer apenas em uma nova consulta à primeira página
    And a página já carregada por "Ana" não deve repetir nem perder entradas

  Scenario: [Falha de banco] Banco indisponível durante a consulta
    Given que o banco de dados fica indisponível
    When "Ana" abrir a aba "Timeline"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o front deve exibir "Não foi possível carregar a timeline agora. Tente novamente em instantes." com botão "Tentar novamente"

  Scenario: [Falha de integração] Redis indisponível não impede a leitura
    Given que o Redis (cache de permissões) está indisponível
    When "Ana" abrir a aba "Timeline"
    Then a API deve responder 200 normalmente, resolvendo a permissão diretamente no banco
    And deve ser registrado log "warn" "permission_cache.unavailable" com a métrica correspondente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Processo não visível, inexistente ou de outro tenant | 404 | `PROCESS_NOT_FOUND` | "Processo não encontrado." | Redireciona para a lista de processos |
| Período inválido | 422 | `VALIDATION_ERROR` | "O período final deve ser igual ou posterior ao inicial." | Marca os campos de período |
| Cursor inválido ou expirado | 422 | `VALIDATION_ERROR` | "Não foi possível continuar a listagem. Role novamente desde o início." | Reinicia a paginação do zero |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar a timeline agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém filtros aplicados |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão para copiar o código |

## Dependências
- **Stories:** US-059 (projeta as entradas consultadas aqui).
- **Decisões/ADRs:** DEC-003 (fuso/datas), DEC-024 (visibilidade do processo), DEC-025 (timeline × auditoria).
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:** não há, em entities.md ou events.md, um enum/registro de agrupamento ("grupo"/categoria) para `TimelineEntryType` (confirmado por busca nos dois arquivos). Esta story define o agrupamento da RN-TML-12 como mapeamento estático de apresentação (código/`packages/types`), sem nova coluna em `process_timeline_entries`. Proposta: se um dia for necessário filtrar por grupo diretamente no banco (e não apenas em memória, combinado a `processId`), formalizar um registro `TimelineEntryGroup` em versão futura.

## Impacto técnico
- A paginação por cursor reaproveita o índice `(tenant_id, process_id, occurred_at DESC, id DESC)` já criado por US-059; o filtro POL-09 (RN-TML-13) deve ser aplicado na cláusula `WHERE` da própria consulta, nunca por filtragem em memória após paginar, para manter `nextCursor`/`hasMore` corretos.
- O dicionário de mensagens (`type` → texto com placeholders) deve ser compartilhado entre backend (fonte da verdade do registro `TimelineEntryType`) e frontend (renderização), de preferência publicado como um único artefato em `packages/types`, para evitar divergência entre os dois.
- O mapeamento de grupos (RN-TML-12) é uma constante de apresentação; qualquer novo `TimelineEntryType` adicionado por outra story deve ser incluído em um dos grupos existentes ou motivar um novo grupo.

## Backend
- **Módulo(s):** `timeline` (dono).
- **Casos de uso:** `GetProcessTimelineQuery` → `GetProcessTimelineHandler`.
- **Domínio:** leitura direta de `ProcessTimelineEntry` (sem regra de escrita); `TimelineEntryPresenter` (expõe `type`, `params`, `actor`, `visibility`; nunca uma mensagem pré-formatada — RN-TML-14).
- **Integrações internas:** `access` (`AuthorizationService.assertCan('PROCESS_VIEW', { processId })` e verificação de POL-09 para excluir `BUDGET_RESTRICTED`).
- **Transação:** leitura simples, sem transação explícita (isolamento padrão `READ COMMITTED`), com `app.tenant_id` definido para RLS.

## Frontend
- **Tela(s):** SCR-006, aba "Timeline" (`/processos/[id]`).
- **Componentes:** `TimelineFeed` (scroll infinito), `TimelineFilterBar` (grupo/autor/período), `TimelineDayGroup`, `TimelineEntryItem` (ícone por grupo; mensagem renderizada via dicionário de `TimelineEntryType`), `EmptyState`, `FilterEmptyState`.
- **Estados:** skeleton na carga inicial; vazio (sem entradas); vazio por filtro; erro com "Tentar novamente"; indicador de carregamento ao buscar mais itens.
- **Acessibilidade e responsividade:** cabeçalhos de dia como `<h3>` para navegação por leitor de tela; itens com `aria-label` combinando mensagem e horário; filtros navegáveis por teclado; em telas < 768 px a barra de filtros vira painel colapsável.

## Banco de dados
- **Tabelas:** `process_timeline_entries` (somente leitura).
- **Migrações:** nenhuma — reaproveita a tabela e os índices criados em US-059.
- **Índices/constraints relevantes:** índice `(tenant_id, process_id, occurred_at DESC, id DESC)` (entities.md §4.10); nenhum índice novo previsto para os filtros de `group`/`actorId`/período, combinados ao `processId` já seletivo.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `PRC-12` | GET | `/api/v1/processes/{id}/timeline` | Query: `cursor?`, `limit?`, `group?`, `actorId?`, `occurredFrom?`, `occurredTo?` | `200 { data: [{ id, occurredAt, type, actorType, actorId, actorName, actorDepartmentName, entityType, entityId, movementId, params, visibility }], meta: { nextCursor, hasMore } }` | 200, 401, 403, 404, 422, 429, 500, 503 |

## Logs
- `info` `timeline.listed` — `processId`, hash dos filtros aplicados, quantidade de resultados, `durationMs`.
- `warn` `authorization.cache_unavailable` — quando o Redis falhar na checagem de permissões/políticas (nome do evento adotado pela US-097; esta story o citava como `permission_cache.unavailable`).
- `error` `timeline.query_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** conteúdo de `params` sensíveis, trechos de comentários.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `access.denied` | `ACCESS` | Tentativa de leitura sem `PROCESS_VIEW` | `reasonCode = PROCESS_VIEW` |

## Testes necessários
- **Unitários:** mapeamento de grupo (RN-TML-12); regra de visibilidade `BUDGET_RESTRICTED` (RN-TML-13); validação de período e cursor.
- **Integração (Testcontainers):** RLS; paginação por cursor estável sob inserções concorrentes; combinação de filtros por ator/grupo/período.
- **API/contrato:** schema de resposta de `PRC-12` compatível com api.md (paginação por cursor §1.2); snapshot OpenAPI.
- **RBAC e multi-tenant:** matriz `PROCESS_VIEW` × `PROCESS_VIEW_CONFIDENTIAL_BUDGET` × custódia; processo de outro tenant → 404.
- **Concorrência:** leitura durante escrita simultânea do projetor (US-059) sem perder nem duplicar entradas.
- **E2E (Playwright):** abrir a aba "Timeline", aplicar filtros, rolar para carregar mais, validar o agrupamento por dia.
- **Acessibilidade/performance:** axe sem violações sérias na aba; k6 com 30 leituras/s por 2 min → p95 < 300 ms.

## Definition of Done
- [ ] Critérios de aceite em Gherkin automatizados e passando
- [ ] `PROCESS_VIEW` e POL-09 aplicados na API; entradas sigilosas nunca retornadas a quem não tem permissão
- [ ] Paginação por cursor estável sob concorrência (teste dedicado)
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI de `PRC-12` compatível com api.md
- [ ] Logs sem dados sensíveis; métrica de latência com p95 < 300 ms monitorada
- [ ] Aba acessível (axe) e responsiva (360 px)
- [ ] Revisão de código e de segurança aprovadas
- [ ] Dicionário de mensagens `type` → texto documentado e compartilhado entre API e frontend

## Estimativa
**M** — leitura paginada com filtros e uma regra de visibilidade, sem transação de escrita; a complexidade está na combinação de filtros e na meta de performance, não em regras de negócio profundas.

## Prioridade
**P0** — a aba "Timeline" é a principal superfície de consulta do histórico do processo em SCR-006, usada por todas as personas listadas nas telas relacionadas do pacote.
