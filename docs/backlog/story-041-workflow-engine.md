---
id: US-041
title: "Motor de execução: ações disponíveis e avaliação de regras"
epic: EP-007
feature: FT-028
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-040]
modules: [workflow, process]
screens: []
endpoints: [PRC-08, PRC-09]
permissions: [PROCESS_VIEW]
events: []
---

# US-041 — Motor de execução: ações disponíveis e avaliação de regras

## Título
Motor de execução: ações disponíveis e avaliação de regras

## Descrição
**Como** responsável (ou colaborador) por uma etapa de um processo de contratação, **quero** ver exatamente quais ações posso executar agora e quais pendências ainda bloqueiam o avanço, **para** agir com confiança sem tentar uma transição que será rejeitada.

Esta story entrega o motor puro do módulo `workflow` — duas funções da `WorkflowFacade`, `getAvailableActions` e `evaluateRules` — expostas pelos endpoints de leitura `PRC-08` e `PRC-09` e consumidas pelo painel situacional do processo e, internamente, pelos comandos de tramitação (fora desta story) antes de aceitar qualquer transição. O motor é determinístico, somente leitura e opera sobre a `WorkflowVersion` publicada fixada no processo.

## Contexto
- Cada etapa da fase preparatória (Lei 14.133/2021, art. 18) tem exigências próprias (DFD aprovado, ETP completo, pesquisa de preços concluída etc.). O motor de workflow declarativo (DEC-014) e as regras parametrizáveis em JSON Logic (DEC-016) permitem expressar essas exigências como `WorkflowRule` sobre o grafo definido em US-040, sem codificá-las no módulo `process`.
- `PRC-08`/`PRC-09` já constam do catálogo da API como as duas leituras que sustentam o painel situacional (SCR-006, de outro épico) e a decisão de habilitar/desabilitar botões de ação.
- Por ser consumido por toda tramitação futura, o motor precisa de uma fachada única (`WorkflowFacade`) para que UI e backend nunca divirjam sobre quais ações são permitidas.

## Objetivo
Garantir que, para qualquer processo em qualquer etapa, uma única chamada a `PRC-08` e outra a `PRC-09` retornem — com p95 < 150 ms — a lista completa de ações possíveis (cada uma com motivo quando desabilitada) e o checklist de pendências (bloqueantes e avisos), 100% consistentes com a definição publicada do workflow, sem efeitos colaterais.

## Persona
- **Principal:** responsável ou colaborador da etapa atual (qualquer perfil com `PROCESS_VIEW` sobre o processo).
- **Secundárias:** autoridade competente (quando a etapa for `APPROVAL`); módulos internos (`process`, notificações) como consumidores técnicos da `WorkflowFacade`.

## Pré-condições
- Processo existente, visível ao usuário (DEC-024), com `workflowVersionId` fixado e `status = PUBLISHED` na versão.
- `WorkflowVersion` com grafo válido (etapas, transições, regras — validado em US-040/US-045).
- `ProcessStage` ativo determinado para o processo.
- Usuário autenticado com `PROCESS_VIEW`.

## Fluxo principal
1. O usuário abre o painel do processo na etapa atual.
2. O front chama em paralelo `GET /processes/{id}/available-actions` (`PRC-08`) e `GET /processes/{id}/checklist` (`PRC-09`).
3. A API autoriza `PROCESS_VIEW` (DEC-024) e carrega o `ProcessStage` ativo, a `WorkflowVersion` publicada fixada e as `WorkflowRule`/`WorkflowTransition` da etapa.
4. `WorkflowFacade.evaluateRules(...)` monta o `RuleContext v1` (processo, documentos, pesquisa de preços, riscos, etapa — §5.4 de entities.md) e avalia cada `WorkflowRule` ativa de `scope = STAGE_EXIT` da etapa atual: `REQUIRED_DOCUMENT` (status mínimo), `REQUIRED_FIELD` (caminho do contexto preenchido), `REQUIRED_APPROVAL` (aprovação `APPROVED` na última passagem pela etapa indicada) e `CONDITION` (JSON Logic, operadores da allowlist). Cada falha gera uma entrada em `violations[]` (`code = WORKFLOW_RULE`, `ruleId`, `severity`, `message`).
5. `WorkflowFacade.getAvailableActions(...)` monta, para cada `WorkflowTransition` que parte da etapa atual (`FORWARD`/`COMPLETE`), `enabled = true` quando todas as regras `BLOCKING` de `scope TRANSITION` da transição e de `STAGE_EXIT` da etapa passam; caso contrário `enabled = false` com `reasons[]`. Monta também `RETURN` para cada etapa já percorrida (histórico de `ProcessStage` do processo) presente na lista de destinos configurada, e as ações de ciclo de vida (`CLAIM`, `ASSIGN`, `CANCEL`, `SUSPEND`, `RESUME`) com `enabled`/`reasons[]` conforme o status do processo e a titularidade — calculadas fora do grafo de regras.
6. A API responde 200 com a lista de ações e o checklist.
7. O front exibe os botões habilitados (ordenados por `isPrimary`/`displayOrder`), desabilita os demais com `reasons[]` em tooltip, e lista o checklist (pendências bloqueantes em destaque, avisos secundários).

## Fluxos alternativos
- **FA-01 — Etapa `END`:** `getAvailableActions` retorna apenas ações de ciclo de vida; nenhuma ação de avanço.
- **FA-02 — Primeira etapa do processo:** `RETURN` não aparece (não há etapas anteriores percorridas).
- **FA-03 — Regra `CONDITION`/`REQUIRED_FIELD` aponta para caminho fora do `RuleContext`:** deveria ter sido bloqueado na publicação (`WF_RULE_PATH_UNKNOWN`, US-040/US-045); em runtime, a regra é tratada como não satisfeita e registrada em log `error`, sem derrubar a chamada.
- **FA-04 — Avisos presentes:** `WARNING` nunca desabilita a ação; o reconhecimento (`acknowledgedWarnings[]`) só é exigido no comando de execução da transição, fora desta story.
- **FA-05 — Usuário não é o responsável atual:** ações de titularidade (ex.: `CLAIM`) vêm com `enabled = false` e motivo "Você não é o responsável atual"; a consulta em si segue permitida por `PROCESS_VIEW`.

## Regras de negócio
- **RN-WF-23** — `getAvailableActions` retorna uma ação por `WorkflowTransition` com `fromStageId` igual à etapa atual e `action` ∈ {`FORWARD`, `COMPLETE`}, mais uma ação `RETURN` por etapa distinta já percorrida (status `COMPLETED`/`RETURNED` em `ProcessStage`) presente na lista de destinos de retorno da etapa atual.
- **RN-WF-24** — Uma ação de avanço fica `enabled = false` quando existir `WorkflowRule` ativa, severidade `BLOCKING`, de `scope = TRANSITION` da própria transição ou `scope = STAGE_EXIT` da etapa atual, não satisfeita; `reasons[]` traz a `message` de cada uma.
- **RN-WF-25** — Regras `WARNING` não satisfeitas nunca desabilitam a ação; aparecem apenas no checklist, com `severity = WARNING`.
- **RN-WF-26** — `evaluateRules` avalia `REQUIRED_DOCUMENT` comparando o status do(s) documento(s) do `documentTypeCode` contra o `minStatus` (`EXISTS`, `COMPLETE`, `SUBMITTED`, `FINAL`, `APPROVED` — DEC-018) e, quando informado, `minCount`.
- **RN-WF-27** — `evaluateRules` avalia `REQUIRED_FIELD` verificando se o caminho indicado em `RuleContextV1` é não nulo/não vazio; caminhos fora do schema são erro de configuração (FA-03).
- **RN-WF-28** — `evaluateRules` avalia `REQUIRED_APPROVAL` exigindo `Approval.status = APPROVED` vinculada à última passagem pela etapa indicada em `stageKey`.
- **RN-WF-29** — `evaluateRules` avalia `CONDITION` executando a expressão JSON Logic (`json-logic-js`) sobre o `RuleContextV1`, apenas com operadores da allowlist (DEC-016); verdadeiro = regra satisfeita.
- **RN-WF-30** — A unidade responsável de uma etapa alcançada é resolvida por `WorkflowStage.departmentResolution`: `FIXED` usa `fixedDepartmentId`; `REQUESTING_DEPARTMENT`/`REQUESTING_SECRETARIAT` usam os campos homônimos do processo; `CHOSEN_ON_FORWARD` exige a unidade destino informada no comando de encaminhamento (fora desta story).
- **RN-WF-31** — O responsável inicial de uma etapa alcançada é resolvido por `WorkflowStage.assignmentPolicy`: `UNASSIGNED`, `CREATOR` (criador do processo), `DEPARTMENT_HEAD` (titular da unidade resolvida pela RN-WF-30) ou `PREVIOUS_ASSIGNEE` (responsável da passagem anterior, quando existir).
- **RN-WF-32** — Ações de ciclo de vida (`CLAIM`, `ASSIGN`, `CANCEL`, `SUSPEND`, `RESUME`) não dependem de `WorkflowRule`; `enabled` é calculado a partir do `ProcessStatus` (DEC-013) e das políticas de titularidade (POL-04/POL-05); não entram no checklist de `evaluateRules`.
- **RN-WF-33** — Todo cálculo é somente leitura e usa exclusivamente a `WorkflowVersion` fixada no processo (`Process.workflowVersionId`), nunca a versão `DRAFT` corrente do workflow.

## Campos
Nota: esta story não tem formulário de entrada; a tabela documenta os campos de saída consumidos pelo painel situacional.

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Ação | `action` | enum (`TransitionAction` + ciclo de vida) | Sim | `FORWARD`\|`RETURN`\|`APPROVE`\|`REJECT`\|`COMPLETE`\|`CLAIM`\|`ASSIGN`\|`CANCEL`\|`SUSPEND`\|`RESUME` | RN-WF-23/32 |
| Rótulo do botão | `label` | texto | Sim | nome da transição ou rótulo fixo da ação de ciclo de vida | `WorkflowTransition.name` |
| Etapa/transição destino | `toStageKey` / `transitionKey` | texto | Condicional | presente em `FORWARD`/`COMPLETE`/`RETURN` | `WorkflowStage.key` / `WorkflowTransition.key` |
| Habilitada | `enabled` | booleano | Sim | RN-WF-24/32 | calculado |
| Motivos de bloqueio | `reasons[]` | lista de `{ code, message, ruleId? }` | Sim (vazia quando habilitada) | preenchido quando `enabled = false`; `ruleId` em `TRANSITION_BLOCKED` | regras/políticas |
| Pendência (checklist) | `violations[].code/severity/message` | lista | Não | `BLOCKING`\|`WARNING` (api.md §2.1.2) | RN-WF-24..29 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `id` do processo existe, é do tenant atual e visível (DEC-024) | API | — (404 sem detalhe) | `NOT_FOUND` |
| V-02 | Usuário possui `PROCESS_VIEW` cobrindo o processo | API | "Você não tem permissão para visualizar este processo." | `PERMISSION_DENIED` |
| V-03 | `id` do processo mal formatado | API | "Requisição inválida." | `MALFORMED_REQUEST` |

## Permissões
- **Permissão:** `PROCESS_VIEW` com escopo que cubra o processo (DEC-024).
- **Políticas:** nenhuma política contextual adicional (leitura); a titularidade (POL-04/POL-05) influencia apenas `enabled`/`reasons[]` das ações de ciclo de vida, não o acesso à consulta.
- **MFA:** não exigido (consulta, risco L).
- **Sem permissão:** processo não visível — inclusive sem `PROCESS_VIEW` em escopo que cubra o processo — → 404 `NOT_FOUND`, com o mesmo corpo do inexistente (DEC-024 · api.md PRC-08: a consulta é a própria visibilidade). Concessão própria (`ProcessAccess` do usuário — criador, responsável, participante, aprovador) basta para consultar (permissions.md §7).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Motor somente leitura; não gera eventos. Os eventos de transição (ex.: futuro `ProcessForwarded`) são gerados pelos comandos de tramitação que consomem esta fachada, fora desta story. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma (consulta somente leitura). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Motor de execução — ações disponíveis e avaliação de regras

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And o processo "0012/2026" segue o workflow "Fase preparatória — Lei 14.133/2021" publicado
    And o processo está na etapa "Estudos preliminares e mapa de riscos" (ESTUDOS_PRELIMINARES)
    And a etapa tem a regra bloqueante "ETP completo" (REQUIRED_DOCUMENT, minStatus COMPLETE) e a regra de aviso "Mapa de riscos" (REQUIRED_DOCUMENT, minStatus EXISTS, severidade WARNING)

  Scenario: [Sucesso] Ação de avanço habilitada quando as regras bloqueantes estão satisfeitas
    Given que o ETP do processo está "COMPLETE"
    When o front consultar "GET /api/v1/processes/{id}/available-actions"
    Then a ação "FORWARD" para a etapa "Pesquisa de preços" deve vir com "enabled: true"
    And o checklist retornado por "GET /api/v1/processes/{id}/checklist" deve trazer a pendência "Mapa de riscos" com "severity: WARNING"
    And a API deve responder 200 nas duas chamadas

  Scenario: [Validação] Identificador de processo mal formatado
    When o front consultar "GET /api/v1/processes/abc-invalido/available-actions"
    Then a API deve responder 400 com código "MALFORMED_REQUEST"

  Scenario: [Permissão] Usuário sem visibilidade do processo
    Given que "Carla" não tem "PROCESS_VIEW" em escopo que cubra o processo "0012/2026"
    When "Carla" consultar as ações disponíveis do processo "0012/2026"
    Then a API deve responder 404 com código "NOT_FOUND"
    And a resposta não deve indicar se o processo existe

  Scenario: [Tenant incorreto] Processo pertence a outro tenant
    Given que o processo "0007/2026" pertence ao tenant "Prefeitura B"
    When um usuário do tenant "Prefeitura de São José" consultar as ações do processo "0007/2026"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Consultas repetidas não têm efeito colateral
    When o front consultar duas vezes seguidas "GET /api/v1/processes/{id}/available-actions"
    Then as duas respostas devem ser idênticas
    And nenhuma tramitação, auditoria ou evento deve ser gerado pelas consultas

  Scenario: [Concorrência] Leitura durante tramitação concorrente reflete um snapshot consistente
    Given que um segundo usuário encaminha o processo para a etapa "Pesquisa de preços" no exato momento da consulta
    When o front consultar "GET /api/v1/processes/{id}/available-actions"
    Then a resposta deve refletir integralmente a etapa "Estudos preliminares" ou integralmente a etapa "Pesquisa de preços"
    And nunca um estado misto das duas etapas

  Scenario: [Falha de banco] Banco indisponível durante a consulta
    Given que o banco de dados fica indisponível
    When o front consultar "GET /api/v1/processes/{id}/available-actions"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"

  Scenario: [Falha de integração] Expressão JSON Logic malformada chega ao runtime
    Given que a regra "CONDITION" da transição contém uma expressão que falha ao ser avaliada pelo motor de JSON Logic
    When o front consultar o checklist do processo
    Then a regra deve ser tratada como não satisfeita
    And deve ser registrado log "error" "workflow.rule_evaluation_failed" com o "ruleId"
    And a API deve responder 200 normalmente para as demais regras
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Processo inexistente/outro tenant/não visível | 404 | `NOT_FOUND` | — | Tela "Processo não encontrado" |
| Sem `PROCESS_VIEW` | 404 | `NOT_FOUND` | — | Idem (DEC-024 não distingue) |
| Id malformado | 400 | `MALFORMED_REQUEST` | "Requisição inválida." | Erro genérico |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível calcular as ações agora. Tente novamente em instantes." | Botão "Tentar novamente"; mantém painel anterior |
| Erro inesperado na avaliação de regra | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Exibe painel sem as ações; botão copiar código |

## Dependências
- **Stories:** US-040 (modelo de definição de workflow versionado — fornece `WorkflowVersion`/`WorkflowStage`/`WorkflowTransition`/`WorkflowRule` que este motor lê). Indiretas: US-106 (cálculo de dias úteis/SLA usado em `stage.businessDaysInStage`).
- **Decisões/ADRs:** DEC-013, DEC-014, DEC-016, DEC-018, DEC-022, DEC-024, DEC-031; ADR-005, ADR-008.
- **Configurações:** nenhuma chave própria.
- **Lacunas nas fontes canônicas (resolvidas na implementação, 2026-10-15):** (1) o agregado `Process` (tabelas `processes`/`process_stages`/`process_access`) nasce na US-001, posterior a esta story no sprint 6: o módulo `process` lê o runtime pela porta `PROCESS_RUNTIME_READER` (em produção, `PendingProcessRuntimeReader` → 404 até a US-001 entregar o leitor Prisma); (2) `reasons[]` segue o formato de objetos de api.md (`{ code, message, ruleId? }`), não lista de texto; (3) o checklist (PRC-09) traz as regras ativas NÃO satisfeitas de `STAGE_EXIT` da etapa e de `TRANSITION` das saídas `FORWARD`/`COMPLETE` (RN-PROC-51), bloqueantes antes dos avisos; (4) da prévia de `FORWARD`, esta story preenche `departmentResolution`, `requiresComment` e `allowDueDateOverride`; `dueAtPreview` e `approverPreview` ficam com a US-047; (5) avanços também exigem custódia (POL-01) e status `DRAFT`/`IN_PROGRESS`/`RETURNED` — motivos `NOT_PROCESS_CUSTODIAN`/`INVALID_PROCESS_STATUS` antes dos `TRANSITION_BLOCKED`; ações sem a permissão em nenhum escopo são omitidas (permissions.md §9); suspenso mostra `RESUME`, os demais `SUSPEND`; (6) FA-03: caminho fora do schema, operação fora da whitelist, `config` inválido ou expressão que lança no `json-logic-js` → `error workflow.rule_evaluation_failed`; `warn workflow.rule_context_missing_path` fica para caminho do schema ausente no contexto montado.

## Impacto técnico
- O motor deve ser **puro** (sem I/O além de ler o agregado já carregado) para permitir testes de propriedade (fast-check) exaustivos sobre combinações de regras/etapas.
- `WorkflowFacade` exporta `getAvailableActions(input)` e `evaluateRules(input)`; o módulo `process` (tramitação, fora desta story) chama a mesma fachada antes de aceitar uma transição, garantindo que UI e backend nunca divirjam.
- Carregar o grafo completo da `WorkflowVersion` uma vez por chamada; avaliar cache em memória por `workflowVersionId` (imutável após publicação) caso a latência não atenda a meta.
- Incompatibilidade entre o `RuleContext` schema e caminhos usados em `REQUIRED_FIELD`/`CONDITION` é mitigada pela validação de publicação (`WF_RULE_PATH_UNKNOWN`, US-040/US-045); em runtime o motor degrada com segurança (RN-WF-27/FA-03) em vez de lançar exceção.

## Backend
- **Módulo(s):** `workflow` (dono da fachada); consumido por `process`.
- **Casos de uso:** `GetAvailableActionsQuery` → `GetAvailableActionsHandler`; `EvaluateStageRulesQuery` → `EvaluateStageRulesHandler`.
- **Domínio:** `WorkflowFacade.getAvailableActions(ctx)`, `WorkflowFacade.evaluateRules(ctx)`; value object `RuleContextV1`; `RuleEvaluator` (estratégia por `RuleType`); `AvailableAction`.
- **Integrações internas:** `process` (fornece `Process`, `ProcessStage`, histórico de etapas); `document`/pesquisa de preços/`risk` (fornecem dados agregados no `RuleContext`, só leitura).
- **Transação:** nenhuma (somente leitura); contexto de tenant (`app.tenant_id`) aplicado na conexão de leitura.

## Frontend
- **Tela(s):** consumido pelo painel situacional do processo (SCR-006, de outro épico).
- **Componentes:** `AvailableActionsPanel`, `ActionButton` (desabilitado com tooltip de `reasons[]`), `StageChecklist` (lista de `violations[]` por severidade).
- **Estados:** skeleton enquanto `PRC-08`/`PRC-09` carregam; erro com "Tentar novamente"; polling silencioso sem substituir dados já exibidos em caso de falha pontual.
- **Acessibilidade e responsividade:** botões desabilitados mantêm `aria-disabled` e `aria-describedby` com o motivo; checklist usa ícone + texto (não só cor); lista colapsável em telas estreitas.

## Banco de dados
- **Tabelas:** leitura de `workflow_versions`, `workflow_stages`, `workflow_transitions`, `workflow_rules`, `process_stages`, `processes` (e leituras pontuais de documentos/pesquisa de preços/riscos para o `RuleContext`). Nenhuma tabela nova.
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita os índices de US-040 (`(tenant_id, workflow_version_id, key)`) e de `process_stages` (etapa ativa por processo).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| PRC-08 | GET | `/api/v1/processes/{id}/available-actions` | — | `200 { data: [{ action, transitionKey?, toStageKey?, label, enabled, reasons[] }] }` | 200, 400, 404, 429, 500, 503 |
| PRC-09 | GET | `/api/v1/processes/{id}/checklist` | — | `200 { data: { violations: [{ code, severity, message, ruleId }] } }` | 200, 400, 404, 429, 500, 503 |

## Logs
- `info` `workflow.actions_computed` — `processId`, `workflowVersionId`, `stageKey`, quantidade de ações habilitadas/desabilitadas, `durationMs`.
- `warn` `workflow.rule_context_missing_path` — caminho do `RuleContext` não encontrado em `REQUIRED_FIELD`/`CONDITION`.
- `error` `workflow.rule_evaluation_failed` — `ruleId`, `ruleType`, causa resumida, `correlationId`.
- **Nunca logar:** conteúdo de documentos, valores estimados, justificativas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Consulta somente leitura; não gera `AuditLog`. Falhas de avaliação de regra ficam apenas em log (acima). |

## Testes necessários
- **Unitários:** cada `RuleType` (REQUIRED_DOCUMENT com os 5 `minStatus`; REQUIRED_FIELD; REQUIRED_APPROVAL; CONDITION com operadores aceitos/rejeitados); resolução de `DepartmentResolution` e `StageAssignmentPolicy` (RN-WF-30/31).
- **Baseado em propriedades (fast-check):** para grafos de workflow gerados aleatoriamente, `enabled = false` se e somente se existir regra BLOCKING não satisfeita; nunca lança exceção para entradas dentro do schema.
- **Integração (Testcontainers PostgreSQL):** leitura do grafo publicado real (workflow padrão DEC-015); RLS impede ler `workflow_rules` de outro tenant.
- **API/contrato:** respostas de `PRC-08`/`PRC-09` conforme api.md (snapshot OpenAPI).
- **RBAC e multi-tenant:** `PROCESS_VIEW` em cada escopo; processo de outro tenant → 404.
- **Concorrência:** leitura durante tramitação concorrente não retorna estado misto (snapshot único, `READ COMMITTED`).
- **E2E (Playwright):** painel exibe botões corretos para o workflow padrão semeado em cada uma das 7 etapas (DEC-015).
- **Acessibilidade/performance:** k6 com 50 consultas/s → p95 < 150 ms; axe no painel sem violações sérias.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] `PROCESS_VIEW` aplicado via DEC-024; processo de outro tenant retorna 404
- [ ] Testes de propriedade (fast-check) cobrindo os 4 `RuleType` e as transições do grafo
- [ ] `WorkflowFacade` documentada e consumida por `process` sem duplicar a lógica de regras
- [ ] OpenAPI de PRC-08 e PRC-09 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas de latência e trace por etapa
- [ ] Painel acessível (axe) e responsivo (360 px)
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**L** — motor combinatório (4 tipos de regra, múltiplas resoluções de unidade/responsável, ações de ciclo de vida) consumido por todo o restante do produto; exige testes de propriedade exaustivos e nenhuma regressão é aceitável.

## Prioridade
**P0** — sem este motor, nenhuma tramitação do processo sabe quais ações mostrar nem quais pendências bloqueiam o avanço.
