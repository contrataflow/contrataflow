---
id: US-057
title: "Lista de aprovações"
epic: EP-009
feature: FT-036
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-051]
modules: [approval, access]
screens: [SCR-014]
endpoints: [APV-01]
permissions: [APPROVAL_VIEW]
events: []
---

# US-057 — Lista de aprovações

## Título
Lista de aprovações

## Descrição
**Como** aprovador designado (direto, por perfil ou por titularidade de unidade), **quero** ver em uma lista dedicada todas as aprovações pendentes (e, com filtro, as já decididas) em que preciso ou precisei atuar, **para** priorizar minhas decisões sem depender da caixa de tarefas geral.

A tela **SCR-014** (`/aprovacoes`) lista registros de `Approval` restritos à cobertura de aprovador do usuário (DEC-022/POL-03), com filtros por status, tipo de assunto, unidade solicitante e período, e leva ao processo/documento para a decisão em si (US-052).

## Contexto
- "Aprovações pendentes" já aparece como uma das visões da caixa de tarefas (US-056); esta story entrega uma tela dedicada com mais filtros e histórico, para quem decide em volume (ex.: secretário que aprova DFDs de várias unidades).
- Segregação de funções (Lei 14.133/2021, art. 7º, §1º) e a cobertura de aprovador (DEC-022) já determinam quem pode ver e decidir cada `Approval`; esta story reaproveita integralmente essa regra, sem criar nova lógica de autorização.
- A decisão em si (aprovar/devolver/indeferir) é de US-052 e não é reimplementada aqui: cada linha apenas leva ao processo ou documento correspondente.

## Objetivo
Permitir que um aprovador encontre, filtre e abra qualquer aprovação de sua cobertura em até 2 cliques, com a lista sempre restrita exatamente ao que ele tem competência para decidir (nenhuma aprovação fora da cobertura de POL-03 é exibida).

## Persona
- **Principal:** Aprovador designado — direto (`approverUserId`), por perfil (`approverType = ROLE`) ou por titularidade de unidade (`DEPARTMENT_HEAD`, incluindo substituto).
- **Secundárias:** Gestor que acompanha o andamento das aprovações de sua unidade.

## Pré-condições
- Usuário autenticado, tenant `ACTIVE`, vínculo `ACTIVE`.
- Usuário possui `APPROVAL_VIEW` (ou é aprovador designado de ao menos uma `Approval`).
- Existe ao menos uma `Approval` dentro da cobertura do usuário (senão a lista mostra estado vazio).

## Fluxo principal
1. O usuário acessa **"Aprovações"** no menu principal; o sistema navega para **SCR-014** (`/aprovacoes`).
2. O front chama `APV-01` (`GET /approvals?status=PENDING&page=1&pageSize=20&sort=-requestedAt`); exibe skeleton até os dados chegarem. O filtro padrão é `status=PENDING`.
3. Cada linha mostra: processo/documento (`title`), tipo de assunto (etapa do processo ou documento avulso), unidade solicitante, solicitante, data da solicitação, prazo (`dueAt`) e, quando aplicável, indicação de atraso.
4. O usuário aplica filtros (status, tipo de assunto, unidade solicitante, período de solicitação, busca textual por código/título) e/ou ordena por prazo ou data de solicitação; o front reconsulta `APV-01` com os novos parâmetros.
5. O usuário clica em uma linha; o sistema navega para o processo (SCR-006) ou, se o assunto for um documento avulso, para a tela do documento, onde a decisão é tomada (US-052).
6. Ao decidir (em outra tela) e retornar, a lista é revalidada e a linha decidida desaparece do filtro `PENDING` (ou passa a aparecer em `APPROVED`/`RETURNED`/`REJECTED`, se o usuário filtrar por esses status).

## Fluxos alternativos
- **FA-01 — Nenhuma aprovação pendente:** exibe estado vazio "Nenhuma aprovação pendente. Você está em dia!".
- **FA-02 — Aprovação por perfil com muitos titulares:** a linha mostra "Aguardando: qualquer titular de {perfil}" em vez de um nome específico, já que o aprovador efetivo só se define na decisão.
- **FA-03 — Aprovação cancelada enquanto a lista está aberta:** ao revalidar (próxima navegação ou atualização manual), a linha com `status = CANCELED` some do filtro `PENDING`.
- **FA-04 — Processo com orçamento sigiloso:** a linha aparece normalmente (código, título, status); valores financeiros ficam mascarados conforme §1.4 de api.md para quem não atende POL-09.
- **FA-05 — Filtro por período sem resultados:** exibe "Nenhuma aprovação encontrada para os filtros selecionados." com atalho "Limpar filtros".

## Regras de negócio
- **RN-INBOX-14** — A lista de `APV-01` é sempre restrita às `Approval` em que o usuário é aprovador designado conforme a cobertura de POL-03/DEC-022 (direto, perfil com escopo sobre a unidade solicitante, ou titular/substituto de `approverDepartmentId`); nunca exibe aprovações fora dessa cobertura, mesmo que o usuário veja o processo por outro motivo (DEC-024).
- **RN-INBOX-15** — Filtros disponíveis: `status` (um ou mais de `PENDING`, `APPROVED`, `RETURNED`, `REJECTED`, `CANCELED`; múltiplos valores = OU — §1.2 de api.md), `subjectType` (`PROCESS_STAGE`\|`DOCUMENT`), `requestingDepartmentId`, `requestedFrom`/`requestedTo`, `q` (busca textual, mín. 2 caracteres). Sem `status` informado, o padrão é `PENDING`.
- **RN-INBOX-16** — Indicação de atraso na lista usa `Approval.dueAt` (quando preenchido) comparado a agora, sem alterar nem depender de `overdueSince` (campo exclusivo de `ProcessStage` — DEC-031).
- **RN-INBOX-17** — Cada linha apenas navega para o processo/documento; a decisão (`APPROVE`/`RETURN`/`REJECT`) não é executada nesta tela nem por este endpoint (US-052).
- **RN-INBOX-18** — Ordenação padrão `-requestedAt`; campos permitidos: `requestedAt`, `dueAt`, `code`. Paginação por página (`page`/`pageSize`, máx. 100).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Status | `status` (query) | enum múltiplo (`ApprovalStatus`) | Não | RN-INBOX-15 | `PENDING` |
| Tipo de assunto | `subjectType` (query) | enum (`ApprovalSubjectType`) | Não | RN-INBOX-15 | — |
| Unidade solicitante | `requestingDepartmentId` (query) | uuid | Não | unidade ativa do tenant | — |
| Solicitado de / até | `requestedFrom`/`requestedTo` (query) | data | Não | `requestedFrom` ≤ `requestedTo` | — |
| Busca | `q` (query) | texto | Não | mín. 2 caracteres | — |
| Ordenação | `sort` (query) | texto | Não | RN-INBOX-18 | `-requestedAt` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `status`/`subjectType` fora do enum | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_ENUM`) |
| V-02 | `requestedFrom` posterior a `requestedTo` | Front + API | "O período informado é inválido." | `VALIDATION_ERROR` |
| V-03 | `q` com menos de 2 caracteres | Front | — (busca ignorada) | — |
| V-04 | `requestingDepartmentId` de outro tenant/inexistente | API | "Selecione uma unidade válida." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |

## Permissões
- **Permissão:** `APPROVAL_VIEW` (ou ser aprovador designado de ao menos um registro — a listagem em si não exige a permissão explícita quando há designação direta/por perfil/titularidade, conforme política de cobertura).
- **Políticas:** POL-03 (cobertura de aprovador) aplicada como filtro obrigatório da consulta, nunca como checagem posterior.
- **MFA:** não exigido (`APPROVAL_VIEW` é risco `L`).
- **Sem permissão/cobertura:** o menu "Aprovações" não é exibido para quem não tem `APPROVAL_VIEW` nem é aprovador de nada; a API responde lista vazia (nunca 403) quando autenticado, já que a ausência de cobertura apenas resulta em zero itens.

## Eventos gerados
Nenhum. `APV-01` é uma leitura; eventos de aprovação (`ApprovalRequested`, `ApprovalCompleted`, `ApprovalReturned`, `ApprovalRejected`) são gerados por US-051/US-052.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma notificação própria; `APPROVAL_REQUESTED` (in-app) já é enviada por US-051 quando a aprovação é criada. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Lista de aprovações

  Background:
    Given que o usuário "Beatriz" está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo

  Scenario: [Sucesso] Ver aprovações pendentes da minha cobertura
    Given que "Beatriz" é titular da "Secretaria de Obras"
    And existe uma aprovação "PENDING" do tipo "DEPARTMENT_HEAD" para essa secretaria
    When "Beatriz" abrir "Aprovações"
    Then a lista deve conter essa aprovação

  Scenario: [Validação] Período de filtro invertido
    When "Beatriz" filtrar com "requestedFrom" posterior a "requestedTo"
    Then o sistema deve exibir "O período informado é inválido."
    And a API não deve ser chamada com esses parâmetros

  Scenario: [Permissão] Aprovação fora da cobertura não aparece
    Given que existe uma aprovação pendente cujo "approverDepartmentId" é outra secretaria
    When "Beatriz" abrir "Aprovações" com o filtro padrão
    Then essa aprovação não deve aparecer na lista

  Scenario: [Tenant incorreto] Aprovação de outro tenant nunca aparece
    Given que existe uma aprovação pendente para um usuário com o mesmo perfil em outro tenant
    When "Beatriz" abrir "Aprovações" no tenant "Prefeitura de São José"
    Then a lista não deve conter aprovações de outro tenant

  Scenario: [Duplicidade] Mesma aprovação não aparece duas vezes com cobertura por perfil e por titularidade
    Given que "Beatriz" é titular da secretaria e também detém o perfil designado como aprovador da mesma aprovação
    When "Beatriz" abrir "Aprovações"
    Then a aprovação deve aparecer exatamente uma vez na lista

  Scenario: [Concorrência] Aprovação decidida por outra pessoa enquanto a lista está aberta
    Given que "Beatriz" tem a lista de aprovações pendentes aberta
    When outro aprovador decidir a mesma aprovação por titularidade
    And "Beatriz" atualizar a lista
    Then a aprovação decidida não deve mais aparecer no filtro "PENDING"

  Scenario: [Falha de banco] Banco indisponível ao consultar aprovações
    Given que o banco de dados está indisponível
    When "Beatriz" abrir "Aprovações"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"

  Scenario: [Falha de integração] Redis indisponível (cache de contadores por aprovador)
    Given que o Redis está indisponível
    When "Beatriz" abrir "Aprovações"
    Then a API deve responder 200 consultando o banco diretamente, sem cache
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Filtro inválido (enum/data) | 422 | `VALIDATION_ERROR` | "Revise os filtros selecionados." | Marca o filtro inválido |
| Unidade de outro tenant/inexistente | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma unidade válida." | Limpa o filtro |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível carregar as aprovações agora." | Botão "Tentar novamente" |
| Limite de requisições | 429 | `RATE_LIMITED` | "Muitas tentativas. Aguarde alguns segundos." | Respeita `Retry-After` |

## Dependências
- **Stories:** US-051 (solicitação de aprovação — origem dos registros listados). Indiretas: US-052 (decisão, acionada a partir da navegação desta lista), US-097 (perfis e escopos), US-102 (titular/substituto de unidade).
- **Decisões/ADRs:** DEC-022, DEC-024, DEC-031.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita integralmente a cobertura de aprovador (POL-03) já implementada para a decisão (US-052); o risco é manter as duas implementações (filtro de listagem e checagem de decisão) sincronizadas — recomenda-se extrair a cobertura para uma função única (`ApprovalCoverageFacade.listCoveredApprovals`) usada por ambas.
- Consulta simples (uma tabela, com filtros indexados), sem o custo de UNION de US-056.

## Backend
- **Módulo(s):** `approval` (dono); usa `organization` (titular/substituto) e `access` (visibilidade complementar de processo, quando necessário para exibir dados do processo).
- **Casos de uso:** `ListApprovalsQuery` → `ListApprovalsHandler` (APV-01).
- **Domínio:** nenhuma entidade nova; reaproveita `Approval`.
- **Integrações internas:** `ApprovalCoverageFacade` (cobertura POL-03, compartilhada com US-052).
- **Transação:** leitura única, sem efeitos colaterais.

## Frontend
- **Tela(s):** SCR-014 (`/aprovacoes`).
- **Componentes:** `ApprovalFilters` (status, tipo, unidade, período, busca), `ApprovalTable`, `OverdueBadge`, `EmptyState`.
- **Estados:** skeleton; vazio (geral e "sem resultado para os filtros"); erro com "Tentar novamente".
- **Acessibilidade e responsividade:** filtros com rótulos associados e navegáveis por teclado; tabela em cartões abaixo de 768 px; contraste AA.

## Banco de dados
- **Tabelas:** leitura em `approvals`, `processes`, `departments`; nenhuma tabela nova.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita `(tenant_id, approver_user_id|approver_department_id|approver_role_id) WHERE status = 'PENDING'` e `(tenant_id, process_id, created_at DESC)` de `approvals`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| APV-01 | GET | `/api/v1/approvals` | `?status=&subjectType=&requestingDepartmentId=&requestedFrom=&requestedTo=&q=&page=&pageSize=&sort=` | `200 { data: [{ id, subjectType, process: { id, code, title }, document?, requestingDepartment, requestedBy, requestedAt, dueAt?, status }], meta: { page, pageSize, totalItems, totalPages } }` | 200, 401, 403, 422, 429, 500, 503 |

## Logs
- `info` `approvals.query` — `filters` (sem dados sensíveis), `resultCount`, `durationMs`, `correlationId`.
- `warn` `idempotency.store_unavailable` — quando o Redis falhar e a consulta seguir direto no banco.
- `error` `approvals.query_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** título do processo, `requestComment`, `decisionComment`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | Consulta de leitura; não gera auditoria | — |

## Testes necessários
- **Unitários:** cobertura de aprovador (direto/perfil/titularidade) aplicada como filtro; parsing de filtros.
- **Integração (Testcontainers):** RLS impede aprovações de outro tenant; filtros combinados (status + período + unidade).
- **API/contrato:** resposta e paginação conforme api.md.
- **RBAC e multi-tenant:** aprovador por perfil só vê o que o escopo cobre; titular vs. substituto.
- **Concorrência:** decisão concorrente remove o item do filtro `PENDING` na próxima consulta.
- **E2E (Playwright):** filtrar, ordenar e navegar até o processo para decidir.
- **Acessibilidade/performance:** axe sem violações sérias; p95 < 400 ms com filtros padrão.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `APPROVAL_VIEW`/POL-03 aplicados como filtro da consulta (nunca pós-filtro)
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de APV-01 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de latência presentes
- [ ] Acessibilidade (axe) e responsividade (360 px) verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — consulta de uma única tabela já modelada, com filtros e navegação; sem UNION, sem nova lógica de autorização (reaproveita POL-03).

## Prioridade
**P0** — sem esta lista, aprovadores que decidem em volume dependem apenas da aba genérica da caixa de tarefas, insuficiente para sua rotina.
