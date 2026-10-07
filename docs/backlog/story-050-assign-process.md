---
id: US-050
title: "Atribuir e reatribuir responsável"
epic: EP-008
feature: FT-033
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-049]
modules: [process, organization, access, timeline, audit, platform]
screens: [SCR-115]
endpoints: [PRC-22]
permissions: [PROCESS_ASSIGN]
events: [ProcessAssigned]
---

# US-050 — Atribuir e reatribuir responsável

## Título
Atribuir e reatribuir responsável

## Descrição
**Como** gestor de contratações, titular ou substituto da unidade que está com o processo, **quero** atribuir ou trocar o responsável individual por um processo, **para** distribuir o trabalho da equipe e reagir a ausências, férias ou mudanças de prioridade sem depender de o próprio servidor "assumir" (US-049).

A atribuição define quem passa a responder individualmente pelo processo dentro da unidade atual; a reatribuição troca esse responsável por outro (ou o remove, devolvendo o processo para a fila da unidade). Ao contrário de "assumir" (autoatribuição, sem motivo), atribuir é uma ação sobre terceiros e, quando há troca de responsável já definido, exige motivo.

## Contexto
- Em equipes maiores, quem gerencia a fila (gestor, titular ou substituto da unidade) precisa redistribuir processos sem esperar que alguém o assuma espontaneamente — por exemplo, ao notar que um responsável está sobrecarregado ou saiu de férias.
- DEC-023 (custódia) já prevê esta exceção: gestores com `PROCESS_ASSIGN` no escopo, ou o titular/substituto da unidade atual, podem atribuir/reatribuir mesmo sem serem o responsável atual.
- Diferente da devolução (US-048) e do encaminhamento (US-047), a atribuição não move o processo entre etapas ou unidades — só troca quem, dentro da mesma unidade atual, responde por ele.

## Objetivo
Permitir que um gestor, titular ou substituto redistribua a responsabilidade de um processo em até 30 segundos, com motivo obrigatório sempre que houver troca de um responsável já definido, e sem permitir atribuir a quem não pertence à unidade atual.

## Persona
- **Principal:** gestor de contratações com `PROCESS_ASSIGN` no escopo; titular (`headUserId`) ou substituto (`deputyUserId`) da unidade atual do processo.
- **Secundárias:** novo responsável designado (recebe a notificação).

## Pré-condições
- Processo com status `IN_PROGRESS` ou `RETURNED`; etapa atual do tipo `TASK` ou `START` (não `APPROVAL`).
- Usuário possui `PROCESS_ASSIGN` com escopo que cubra o processo, **ou** é titular/substituto da `currentDepartmentId`.
- Quando informado, o novo responsável tem vínculo ativo, lotação na `currentDepartmentId` e `PROCESS_VIEW`.

## Fluxo principal
1. No painel do processo (SCR-006) ou na caixa de tarefas da unidade (SCR-013), o usuário aciona **"Atribuir"** (ou "Reatribuir", se já houver responsável).
2. O sistema abre o diálogo SCR-115 e lista os membros ativos lotados na unidade atual (com cargo e carga de trabalho atual, quando disponível).
3. O usuário escolhe o novo responsável (ou "Deixar na fila da unidade", equivalente a `null`) e, se já houver responsável definido ou estiver removendo um responsável, escreve o **motivo** (mínimo 10 caracteres).
4. O usuário confirma. O front envia `POST /api/v1/processes/{id}/assign` com `If-Match` (versão atual do processo).
5. A API, em uma transação com `app.tenant_id`:
   1. recarrega o processo com `SELECT … FOR UPDATE`; valida `If-Match`;
   2. autoriza: `PROCESS_ASSIGN` com escopo sobre o processo **ou** titular/substituto de `currentDepartmentId` (POL-05);
   3. valida o status do processo e o tipo da etapa atual;
   4. se `assigneeId` informado, valida vínculo ativo, lotação na `currentDepartmentId` e `PROCESS_VIEW` → senão `ASSIGNEE_NOT_ELIGIBLE` (422);
   5. valida que `reason` foi informado quando há troca de responsável já definido ou quando `assigneeId = null` removendo um responsável existente → senão `VALIDATION_ERROR` no campo `reason`;
   6. encerra a `ProcessAssignment` ativa (`isActive = false`, `endedAt = now`) e cria a nova (`type = MANUAL`, `assigneeId`, `assignedById = usuário`, `reason`);
   7. atualiza `ProcessStage.assigneeId` e `Process.currentResponsibleId`; incrementa `version`;
   8. cria `ProcessMovement` (`action = ASSIGN`, `fromUserId`/`toUserId`, `comment = reason` quando informado);
   9. concede `ProcessAccess` (`USER`/`RESPONSIBLE`) ao novo responsável, se houver;
   10. grava `AuditLog` `process.assign`, a entrada de timeline `PROCESS_ASSIGNED` e o evento `ProcessAssigned` (`assignmentType = MANUAL`);
   11. confirma a transação.
6. A API responde **200** com o processo atualizado e `ETag` com a nova versão.
7. O front invalida a caixa de tarefas e o painel do processo, exibindo "Processo atribuído a {nome}" (ou "Processo devolvido para a fila da unidade").

## Fluxos alternativos
- **FA-01 — Primeira atribuição (sem responsável anterior):** motivo não é exigido, pois não há "troca" a justificar.
- **FA-02 — Remover responsável (`assigneeId = null`):** processo volta para a fila da unidade; qualquer lotado elegível pode assumi-lo depois (US-049); motivo é exigido (há troca de um responsável definido para nenhum).
- **FA-03 — Titular/substituto sem `PROCESS_ASSIGN` explícito:** mesmo sem a permissão, o diálogo fica disponível para quem é `headUserId`/`deputyUserId` da unidade atual (DEC-023, §7).
- **FA-04 — Reenvio após falha de rede:** o comando não aceita `Idempotency-Key` (não cadastrado no catálogo); a proteção contra duplo envio é o `If-Match`, que torna o segundo envio um `VERSION_CONFLICT` caso o primeiro já tenha sido aplicado.

## Regras de negócio
- **RN-TRAM-36** — Quem pode atribuir/reatribuir (POL-05): `PROCESS_ASSIGN` com escopo `TENANT`/`ORGANIZATION` cobrindo o processo, **ou** ser titular (`headUserId`) ou substituto (`deputyUserId`) da `currentDepartmentId`. Sem nenhuma das duas condições: `PERMISSION_DENIED` (403).
- **RN-TRAM-37** — Aplicável apenas com o processo `IN_PROGRESS` ou `RETURNED` e etapa atual do tipo `TASK`/`START`; em etapa `APPROVAL` ou status incompatível, `INVALID_PROCESS_STATUS` (409).
- **RN-TRAM-38** — Quando informado, o novo responsável deve ter vínculo `ACTIVE`, lotação (não necessariamente principal) na `currentDepartmentId` e `PROCESS_VIEW`; caso contrário, `ASSIGNEE_NOT_ELIGIBLE` (422).
- **RN-TRAM-39** — `reason` (texto, 10–2.000 caracteres) é obrigatório sempre que já exista um `currentResponsibleId` antes da chamada (reatribuição, inclusive para `null`); é opcional na primeira atribuição a partir da fila da unidade (`currentResponsibleId` previamente nulo).
- **RN-TRAM-40** — `assigneeId = null` é uma atribuição válida ("deixar na fila da unidade"): encerra a atribuição ativa e não cria responsável individual; a etapa permanece com a mesma unidade.
- **RN-TRAM-41** — Autoatribuição é permitida (o próprio gestor pode se designar responsável), desde que atenda RN-TRAM-38 como qualquer outro candidato.
- **RN-TRAM-42** — `ProcessAssignment.type = MANUAL` para toda atribuição feita por esta ação (primeira atribuição, reatribuição ou remoção), distinguindo-a de `CLAIM` (US-049) e `RETURN` (US-048, atribuição automática na devolução).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Novo responsável | `assigneeId` | seleção (usuário) ou `null` | Sim (pode ser `null`) | lotado na unidade atual; vínculo ativo; `PROCESS_VIEW`; RN-TRAM-38 | — |
| Motivo | `reason` | texto longo | Condicional (RN-TRAM-39) | 10–2.000 caracteres | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `assigneeId` ausente no corpo (campo deve estar presente, mesmo que `null`) | Front + API (Zod) | "Selecione um responsável ou deixe na fila da unidade." | `VALIDATION_ERROR` |
| V-02 | `reason` ausente em reatribuição/remoção | Front + API | "Informe o motivo da troca de responsável." | `VALIDATION_ERROR` |
| V-03 | `reason` com menos de 10 caracteres | Front + API | "O motivo deve ter ao menos 10 caracteres." | `VALIDATION_ERROR` |
| V-04 | Novo responsável inválido (sem vínculo/lotação/visão) | API | "Esta pessoa não pode ser responsável por este processo." | `ASSIGNEE_NOT_ELIGIBLE` |
| V-05 | Usuário sem `PROCESS_ASSIGN` nem titularidade/substituição | API | "Você não pode atribuir responsáveis neste processo." | `PERMISSION_DENIED` |
| V-06 | Status/etapa incompatíveis | API | "Este processo não pode ser atribuído no momento." | `INVALID_PROCESS_STATUS` |
| V-07 | `If-Match` divergente | API | "Os dados do processo mudaram. Atualize a página." | `VERSION_CONFLICT` |

## Permissões
- **Permissão:** `PROCESS_ASSIGN` com escopo que cubra o processo, **ou** titular/substituto da unidade atual (POL-05).
- **Políticas:** POL-05 (Atribuir).
- **MFA:** não exigido (`PROCESS_ASSIGN` é risco `M`), salvo `security.mfaPolicy = ALL`.
- **Sem permissão:** o botão "Atribuir"/"Reatribuir" não é exibido para quem não tem a permissão nem é titular/substituto; a API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ProcessAssigned` | `process.assigned` | Commit da atribuição | `assignmentType = MANUAL`, `fromUserId?`, `toUserId?`, `hasReason` |

Projeção síncrona: entrada `PROCESS_ASSIGNED` na timeline ("{actor} atribuiu o processo a {toUserName}"); `ProcessAccess` (`RESPONSIBLE`) concedida ao novo responsável, quando houver.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `PROCESS_ASSIGNED` | Novo responsável, exceto quando ele próprio é quem fez a atribuição | IN_APP + EMAIL (opcional) | Evento `ProcessAssigned` (`MANUAL`) |

Não obrigatória (usuário pode desativar os canais não obrigatórios — US-113). Quando `assigneeId = null`, não há destinatário individual a notificar.

## Critérios de aceite em Gherkin
```gherkin
Feature: Atribuir e reatribuir responsável

  Background:
    Given que o usuário está autenticado no tenant "Prefeitura de São José"
    And possui vínculo ativo
    And existe o processo "0012/2026" na etapa "TERMO_REFERENCIA", unidade "Setor de Compras", responsável "Felipe"

  Scenario: [Sucesso] Gestor reatribui o processo a outro membro da equipe
    Given que "Renata" tem "PROCESS_ASSIGN" com escopo "TENANT"
    And "Juliana" está lotada no "Setor de Compras" com "PROCESS_VIEW"
    When "Renata" atribuir o processo "0012/2026" a "Juliana" com o motivo "Felipe está de férias"
    Then o processo deve passar a ter "Juliana" como responsável atual
    And deve existir uma tramitação de ação "ASSIGN"
    And deve gerar registro de auditoria "process.assign"
    And deve gerar o evento "ProcessAssigned" com "assignmentType" igual a "MANUAL"
    And "Juliana" deve receber notificação "PROCESS_ASSIGNED"

  Scenario: [Validação] Reatribuição sem motivo
    When "Renata" tentar reatribuir o processo "0012/2026" de "Felipe" para "Juliana" sem informar motivo
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "reason"
    And o processo deve continuar com "Felipe" como responsável

  Scenario: [Permissão] Usuário sem PROCESS_ASSIGN e sem titularidade da unidade
    Given que "Marcos" não tem "PROCESS_ASSIGN" nem é titular ou substituto do "Setor de Compras"
    When "Marcos" enviar POST para "/api/v1/processes/0012-2026/assign" com um corpo válido
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Novo responsável de outro tenant
    Given que existe o usuário "Paulo" vinculado apenas à "Prefeitura B"
    When "Renata", no tenant "Prefeitura de São José", enviar POST com "assigneeId" de "Paulo"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND" no campo "assigneeId"
    And a resposta não deve revelar que "Paulo" existe em outro tenant

  Scenario: [Duplicidade] Reenvio do mesmo comando após a aplicação
    Given que "Renata" reatribuiu o processo "0012/2026" para "Juliana" e recebeu 200 com "ETag" igual a "5"
    When o front reenviar automaticamente a mesma requisição ainda com "If-Match" igual a "4"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And o processo deve continuar com "Juliana" como responsável, sem nova tramitação

  Scenario: [Concorrência] Dois gestores reatribuem ao mesmo tempo
    Given que "Renata" e "Tiago" têm "PROCESS_ASSIGN" com escopo "TENANT"
    When ambos enviarem reatribuições diferentes para o processo "0012/2026" na mesma janela de tempo
    Then apenas a primeira requisição a confirmar deve ser aplicada
    And a segunda deve receber 412 com código "VERSION_CONFLICT"

  Scenario: [Falha de banco] Banco indisponível durante a atribuição
    Given que o banco de dados fica indisponível durante a transação
    When "Renata" confirmar a atribuição
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o processo deve permanecer com o responsável anterior

  Scenario: [Falha de integração] Relay do outbox indisponível
    Given que o relay do outbox está indisponível
    When "Renata" atribuir o processo "0012/2026" com sucesso
    Then a API deve responder 200
    And o evento "ProcessAssigned" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Motivo ausente em reatribuição | 422 | `VALIDATION_ERROR` | "Informe o motivo da troca de responsável." | Foca o campo motivo |
| Responsável não elegível | 422 | `ASSIGNEE_NOT_ELIGIBLE` | "Esta pessoa não pode ser responsável por este processo." | Remove a opção da lista; recarrega |
| Referência de outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione um responsável válido." | Recarrega a lista de membros |
| Sem permissão/titularidade | 403 | `PERMISSION_DENIED` | "Você não pode atribuir responsáveis neste processo." | Botão não exibido |
| Status/etapa incompatíveis | 409 | `INVALID_PROCESS_STATUS` | "Este processo não pode ser atribuído no momento." | Botão não exibido |
| Versão divergente | 412 | `VERSION_CONFLICT` | "Os dados do processo mudaram. Atualize a página." | Recarrega o painel |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível atribuir o processo agora. Tente novamente em instantes." | Botão "Tentar novamente" |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-049 (assumir — ação alternativa de autoatribuição); US-047 (origem da primeira entrada em uma etapa `TASK`); US-102 (titular/substituto da unidade).
- **Decisões/ADRs:** DEC-023, DEC-024, DEC-055, DEC-104.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma.

## Impacto técnico
- Reaproveita o padrão transacional das demais ações de tramitação; sem migrações novas.
- A verificação "titular ou substituto da unidade" exige consultar `Department.headUserId`/`deputyUserId` (US-102) além do `AuthorizationService` — ponto de integração entre os módulos `process` e `organization`.

## Backend
- **Módulo(s):** `process` (dono); fachadas de `organization` (`DepartmentFacade.isHeadOrDeputy`), `access` (`AuthorizationService.assertCan('PROCESS_ASSIGN')` ou a exceção de titularidade), `timeline`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `AssignProcessCommand` → `AssignProcessHandler`.
- **Domínio:** `Process.assign(assigneeId, reason?, actorId)`; `ProcessAssignment.reassign(...)`.
- **Transação:** passos 5.1–5.11 do fluxo principal, isolamento `READ COMMITTED` + bloqueio de linha do processo.

## Frontend
- **Tela(s):** SCR-115 (diálogo sobre SCR-006 e SCR-013).
- **Componentes:** `DepartmentMemberSelect` (lista membros da unidade atual, com opção "Deixar na fila da unidade"), `TextareaField` (motivo, condicional), `ConfirmButton`.
- **Estados:** skeleton ao carregar membros; vazio ("Nenhum outro membro ativo nesta unidade"); erro de carregamento; sucesso fecha o diálogo e atualiza o painel.
- **Acessibilidade e responsividade:** foco inicial no seletor de responsável; campo de motivo anunciado como obrigatório via `aria-required` quando aplicável; diálogo em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `process_assignments`, `process_stages`, `processes`, `process_access`, `process_movements`, `process_timeline_entries`, `audit_logs`, `outbox_events`.
- **Migrações:** nenhuma nova.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, process_id) WHERE is_active` em `process_assignments`; índice `(tenant_id, department_id) WHERE is_active AND assignee_id IS NULL` para listar a fila da unidade após remoção.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-22 | POST | `/api/v1/processes/{id}/assign` | `{ assigneeId: string \| null, reason? }` + `If-Match` | `200 { data: Process }` com `currentResponsible`, `version` | 200, 403, 404, 409, 412, 422, 428, 429, 500, 503 |

## Logs
- `info` `process.assigned` — `processId`, `fromUserId?`, `toUserId?`, `actorId`, `durationMs`, `correlationId`.
- `warn` `assign.not_head_or_deputy_fallback` — quando a autorização só passou pela exceção de titularidade/substituição (sem `PROCESS_ASSIGN` explícito) — útil para auditoria de uso da exceção.
- `error` `process.assign_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** o texto do motivo (`reason`).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.assign` | `WORKFLOW` | Commit da atribuição | `changes`: `currentResponsibleId`. `metadata`: `fromUserId?`, `toUserId?`, `viaHeadOrDeputy: boolean`, `reasonLength?` |
| `access.denied` | `ACCESS` | Tentativa sem permissão/titularidade | `reasonCode = PROCESS_ASSIGN` |

## Testes necessários
- **Unitários:** `reason` obrigatório só em reatribuição/remoção; validação de elegibilidade do novo responsável.
- **Integração (Testcontainers):** titular/substituto sem `PROCESS_ASSIGN` explícito consegue atribuir; gestor com escopo `TENANT` também; RLS.
- **API/contrato:** respostas e erros conforme api.md; `assigneeId: null` aceito e serializado corretamente.
- **RBAC e multi-tenant:** matriz de quem pode atribuir (gestor, titular, substituto, nenhum dos três); `assigneeId` de outro tenant → `REFERENCE_NOT_FOUND`.
- **Concorrência:** duas reatribuições simultâneas → uma 200, outra `VERSION_CONFLICT`.
- **E2E (Playwright):** atribuir a partir da fila da unidade; reatribuir com motivo; remover responsável.
- **Acessibilidade/performance:** axe no diálogo; p95 < 500 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_ASSIGN`/exceção de titularidade (POL-05) aplicados na API; UI oculta/desabilita conforme regras
- [ ] Validação condicional de `reason` cobertas por testes unitários
- [ ] Auditoria `process.assign` e evento `ProcessAssigned` verificados em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] OpenAPI de PRC-22 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace presentes
- [ ] Diálogo acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — além do comando transacional padrão, exige a verificação cruzada de titularidade/substituição da unidade (módulo `organization`) e a regra condicional de motivo obrigatório.

## Prioridade
**P0** — gestores precisam redistribuir trabalho sem depender da iniciativa espontânea de cada servidor (US-049), especialmente em ausências e picos de demanda.
