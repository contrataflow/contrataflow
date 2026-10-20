---
id: US-044
title: "Regras de etapa e de transição"
epic: EP-007
feature: FT-030
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-041, US-043]
modules: [workflow]
screens: [SCR-035]
endpoints: [WF-16, WF-17, WF-18, WF-19, PRC-01, WF-23]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE]
events: []
---

# US-044 — Regras de etapa e de transição

## Título
Regras de etapa e de transição

## Descrição
**Como** administrador do órgão, **quero** configurar regras (`WorkflowRule`) de saída de etapa ou de transição — documento obrigatório, campo obrigatório, aprovação obrigatória ou condição — e testá-las contra um processo real antes de publicar, **para** que o motor de workflow (US-041) bloqueie ou avise corretamente quando o processo não estiver pronto para avançar.

A configuração acontece no painel SCR-035, acessado a partir do editor de workflow (US-043), sobre a `WorkflowVersion` em `DRAFT`. Cada regra pertence a exatamente uma etapa (saída) ou a uma transição, tem um tipo com configuração própria (`config`), uma severidade (`BLOCKING` ou `WARNING`) e uma mensagem exibida ao usuário quando não satisfeita. O construtor de condições — construtor próprio (`ConditionBuilder`: combinador E/OU + linhas campo/operador/valor, com edição em JSON como alternativa; o react-querybuilder previsto não entrou — dependência nova fora do catálogo, RN-FND-11, decisão de 2026-10-16) — usa os campos do `RuleContext` (`WF-19`) e gera JSON Logic. Um botão "Testar regra" avalia a regra em elaboração contra um processo existente, sem salvar nada, para validar o comportamento antes de publicar a versão (US-045).

## Contexto
- O motor de execução (US-041, `WorkflowFacade.evaluateRules`) já sabe avaliar `WorkflowRule` dos quatro tipos definidos em DEC-016/entities.md §5.5, mas nenhuma story anterior oferece interface para criar essas regras — hoje elas só existem semeadas pelo workflow padrão (US-042).
- Regras parametrizáveis em JSON Logic (DEC-016) evitam codificar exigências legais (ex.: ETP completo antes da aprovação da autoridade — art. 18) diretamente no módulo `process`; o administrador do órgão mantém essas exigências como configuração.
- Depende do editor (US-043): etapas e transições já precisam existir na `WorkflowVersion` em `DRAFT` antes de se criar regras sobre elas.

## Objetivo
Permitir que um administrador configure e valide uma regra completa (tipo, âmbito, severidade, mensagem e condição testada) em menos de 3 minutos, com 100% das regras salvas referenciando etapas/transições da própria versão e nenhuma regra publicável com configuração estruturalmente inválida.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, com `WORKFLOW_MANAGE`).
- **Secundárias:** Gestor de contratações e demais perfis com `WORKFLOW_VIEW` (consulta das regras, sem edição).

## Pré-condições
- Existe uma `WorkflowVersion` em `DRAFT` com ao menos uma `WorkflowStage`/`WorkflowTransition` criada (US-043).
- Usuário com `WORKFLOW_MANAGE` para editar; `WORKFLOW_VIEW` para consultar.
- Para "Testar regra": existe ao menos um processo visível ao usuário (`PROCESS_VIEW`, DEC-024) para escolher como base do teste.

## Fluxo principal
1. No editor do workflow (SCR-034), o administrador abre a aba/rota "Regras" (SCR-035) de uma etapa ou transição.
2. O sistema chama `GET /rule-context/schema` (`WF-19`) e monta o construtor com os campos disponíveis (`process.*`, `documents.<TYPE>.*`, `priceResearch.*`, `risks.*`, `items.*`, `stage.*`, `now`).
3. O administrador clica em "Nova regra", escolhe o **tipo** (`REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL` ou `CONDITION`) e preenche a configuração correspondente, a **severidade**, o **nome** e a **mensagem** exibida ao usuário.
4. Para `CONDITION`, o administrador monta a expressão no construtor de condições (campo, operador, valor); o front converte para JSON Logic.
5. O front envia `POST /api/v1/workflow-versions/{versionId}/rules` (`WF-16`). A API valida âmbito, referências e a forma do `config` (RN-WF-53 a 58) e persiste a regra.
6. O administrador clica em **"Testar regra"**: escolhe um processo existente (busca por código/título, `PRC-01`) e o front envia `POST /api/v1/workflow-versions/{versionId}/rules/test` (`WF-23`); a API avalia a configuração informada contra o `RuleContextV1` real do processo e devolve satisfeita/não satisfeita com os valores usados, sem persistir nada.
7. O sistema exibe o resultado do teste junto ao formulário ("Satisfeita" ou "Não satisfeita — {mensagem}") para ajuste antes de salvar.
8. Alterações posteriores usam `PATCH /api/v1/workflow-rules/{ruleId}` (`WF-17`) com `If-Match`; exclusão usa `DELETE /api/v1/workflow-rules/{ruleId}` (`WF-18`).

## Fluxos alternativos
- **FA-01 — Reordenar regras:** arrastar uma regra na lista atualiza `displayOrder` de todas as regras do mesmo âmbito via `PATCH` em lote (uma chamada `WF-17` por item alterado).
- **FA-02 — Desativar sem excluir:** alternar "Ativa" (`isActive=false`) mantém a regra fora de `evaluateRules` (US-041) sem perder a configuração; usado para suspender temporariamente uma exigência.
- **FA-03 — Testar regra ainda não salva:** o botão "Testar" funciona mesmo antes do primeiro `POST`, enviando a configuração do formulário diretamente ao endpoint de teste (não depende de `ruleId`).
- **FA-04 — Caminho de `REQUIRED_FIELD` desconhecido:** o construtor só lista caminhos do schema (`WF-19`); se um caminho for colado manualmente e não existir, o salvamento é aceito (validação profunda ocorre na publicação — US-045, `WF_RULE_PATH_UNKNOWN`) e o teste retorna "não satisfeita" com aviso "Campo não reconhecido".
- **FA-05 — Versão não é mais rascunho:** se outra pessoa publicar a versão enquanto o painel está aberto, qualquer `POST`/`PATCH`/`DELETE` subsequente retorna `WORKFLOW_VERSION_NOT_DRAFT`; o front oferece "Criar novo rascunho" (US-045).

## Regras de negócio
- **RN-WF-53** — Uma `WorkflowRule` pertence a exatamente um âmbito: `scope = STAGE_EXIT` com `stageId` preenchido (e `transitionId` nulo) ou `scope = TRANSITION` com `transitionId` preenchido (e `stageId` nulo); a etapa/transição referenciada deve pertencer à mesma `workflowVersionId` (check de banco, entities.md §4).
- **RN-WF-54** — Criar, editar ou excluir regra (`WF-16`/`WF-17`/`WF-18`) só é aceito quando a `WorkflowVersion` dona estiver em `DRAFT` (reaproveita RN-WF-43, US-043); caso contrário, `WORKFLOW_VERSION_NOT_DRAFT` (409).
- **RN-WF-55** — `type = REQUIRED_DOCUMENT`: `config.documentTypeCode` deve ser um `DocumentType` ativo do tenant; `config.minStatus` ∈ {`EXISTS`,`COMPLETE`,`SUBMITTED`,`FINAL`,`APPROVED`} (DEC-018); `config.minCount`, se informado, ≥ 1.
- **RN-WF-56** — `type = REQUIRED_FIELD`: `config.field` é um caminho de texto; o construtor restringe a escolha às opções de `WF-19` (`RuleContextV1`, entities.md §5.4), mas a API aceita o rascunho mesmo com caminho fora do schema — a verificação profunda ocorre na validação de publicação (US-045, `WF_RULE_PATH_UNKNOWN`).
- **RN-WF-57** — `type = REQUIRED_APPROVAL`: `config.stageKey` deve referenciar uma `WorkflowStage` com `type = APPROVAL` existente na mesma `WorkflowVersion`.
- **RN-WF-58** — `type = CONDITION`: `config.expression` é JSON Logic; o executor (compartilhado com `WorkflowFacade.evaluateRules`, US-041, RN-WF-29) restringe operadores à allowlist (DEC-016) tanto em runtime quanto no dry-run do teste de regra; nunca executa código arbitrário.
- **RN-WF-59** — "Testar regra" (`WF-23`) avalia a `config` informada (salva ou não) contra o `RuleContextV1` construído a partir de um processo existente e visível ao usuário (`PROCESS_VIEW`, DEC-024); não cria, altera nem registra `WorkflowRule`, `ProcessMovement` ou auditoria de domínio além do próprio acesso de leitura.
- **RN-WF-60** — `severity` padrão `BLOCKING`; `message` obrigatória (até 500 caracteres); `isActive` padrão `true`; excluir (`WF-18`) é definitivo (`WorkflowRule` não é `+SD`) e só permitido em `DRAFT` (RN-WF-54).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Âmbito | `scope` | seleção (`RuleScope`) | Sim | RN-WF-53 | conforme origem (etapa ou transição) |
| Etapa | `stageId` | seleção | Condicional (`STAGE_EXIT`) | mesma versão | — |
| Transição | `transitionId` | seleção | Condicional (`TRANSITION`) | mesma versão | — |
| Tipo | `type` | seleção (`RuleType`) | Sim | enum | — |
| Nome | `name` | texto curto | Sim | até 150 caracteres | — |
| Descrição | `description` | texto longo | Não | — | — |
| Severidade | `severity` | seleção (`RuleSeverity`) | Sim | enum | `BLOCKING` |
| Mensagem ao usuário | `message` | texto curto | Sim | até 500 caracteres | — |
| Configuração (`REQUIRED_DOCUMENT`) | `config.documentTypeCode`, `config.minStatus`, `config.minCount?` | composto | Condicional | RN-WF-55 | — |
| Configuração (`REQUIRED_FIELD`) | `config.field` | texto (caminho) | Condicional | RN-WF-56 | lista de `WF-19` |
| Configuração (`REQUIRED_APPROVAL`) | `config.stageKey` | seleção | Condicional | RN-WF-57 | etapas `APPROVAL` da versão |
| Configuração (`CONDITION`) | `config.expression` | JSON Logic (construtor de condições) | Condicional | RN-WF-58 | — |
| Ativa | `isActive` | interruptor | Não | — | `true` |
| Ordem de exibição | `displayOrder` | número | Não | ≥ 0 | ordem de criação |
| *(teste)* Processo de referência | `processId` | seleção (busca) | Sim, só no teste | visível ao usuário | — |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Campos obrigatórios ausentes (nome, mensagem, severidade, config por tipo) | Front + API (Zod) | "Informe o {campo}." | `VALIDATION_ERROR` |
| V-02 | `stageId`/`transitionId` incompatível com `scope` ou de outra versão | API | "Selecione uma etapa ou transição válida desta versão." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | `documentTypeCode` inexistente/inativo | API | "Selecione um tipo de documento válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-04 | `stageKey` de `REQUIRED_APPROVAL` não é etapa `APPROVAL` da versão | API | "Selecione uma etapa de aprovação desta versão." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-05 | `message`/`name` acima do limite | Front + API | "O {campo} deve ter até {N} caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |
| V-06 | Editar/excluir regra de versão não `DRAFT` | API | "Esta versão não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-07 | `If-Match` ausente/divergente (`WF-17`/`WF-18`) | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-08 | Testar regra com processo não visível/inexistente | API | "Selecione um processo válido." | `NOT_FOUND` |
| V-09 | Testar regra com `CONDITION` usando operador fora da allowlist | API | "Esta condição usa um operador não permitido." | `WORKFLOW_INVALID` (`WF_RULE_OPERATOR_FORBIDDEN`) |

## Permissões
- **Permissão:** `WORKFLOW_VIEW` para listar/testar em modo leitura; `WORKFLOW_MANAGE` para criar, editar, excluir e reordenar regras.
- **Políticas:** nenhuma política contextual adicional; "Testar regra" soma a verificação de visibilidade do processo escolhido (`PROCESS_VIEW`, DEC-024).
- **MFA:** não exigido (`WORKFLOW_MANAGE` é risco `H`, mas regras não são ação de alto risco isolada); segue `security.mfaPolicy`.
- **Sem permissão:** painel de regras oculto/somente leitura sem `WORKFLOW_VIEW`; botões "Nova regra"/"Testar"/editar ocultos sem `WORKFLOW_MANAGE`; API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Nenhum evento de domínio (reaproveita o padrão de WF-10 a WF-15); apenas auditoria `workflow.update` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; edição de rascunho não notifica ninguém |

## Critérios de aceite em Gherkin
```gherkin
Feature: Regras de etapa e de transição

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o workflow "Fase preparatória — Lei 14.133/2021" com uma "WorkflowVersion" em "DRAFT"
    And a etapa "ESTUDOS_PRELIMINARES" e a etapa "APROVACAO_AUTORIDADE" (tipo "APPROVAL") existem nessa versão
    And o administrador "Carla" possui o perfil "ADMIN_ORGAO" com "WORKFLOW_MANAGE"

  Scenario: [Sucesso] Criar regra de documento obrigatório na saída de uma etapa
    When "Carla" criar uma regra "REQUIRED_DOCUMENT" com "documentTypeCode" "ETP", "minStatus" "COMPLETE" e severidade "BLOCKING" na saída de "ESTUDOS_PRELIMINARES"
    Then a regra deve ser salva vinculada à etapa "ESTUDOS_PRELIMINARES"
    And deve gerar registro de auditoria "workflow.update"

  Scenario: [Validação] Tipo de documento inativo
    When "Carla" selecionar um tipo de documento inativo em "documentTypeCode"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_INACTIVE" no campo "config.documentTypeCode"

  Scenario: [Permissão] Usuário somente leitura tenta criar regra
    Given que "Bruno" possui apenas "WORKFLOW_VIEW"
    When "Bruno" enviar POST para criar uma regra
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Testar regra com processo de outro tenant
    When "Carla" testar uma regra informando o "processId" de um processo do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And a resposta não deve revelar que o processo existe em outro tenant

  Scenario: [Duplicidade] Testar a mesma regra repetidamente não produz efeitos colaterais
    Given que "Carla" já testou a regra duas vezes contra o processo "0012/2026"
    When "Carla" testar a mesma regra uma terceira vez
    Then a API deve responder 200 com o mesmo resultado
    And nenhuma "WorkflowRule" ou registro adicional deve ser criado

  Scenario: [Concorrência] Edição simultânea da mesma regra
    Given que "Carla" e "Diego" abrem a mesma regra com "ETag" "3"
    When "Diego" salvar primeiro e "Carla" enviar "PATCH" com "If-Match" "3"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And "Carla" deve recarregar a regra antes de tentar novamente

  Scenario: [Falha de banco] Banco indisponível ao salvar regra
    Given que o banco de dados fica indisponível
    When "Carla" salvar uma nova regra
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And nenhuma regra deve ser persistida

  Scenario: [Falha de integração] Falha ao carregar o schema do RuleContext
    Given que o serviço que fornece "WF-19" está indisponível
    When "Carla" abrir o construtor de condições
    Then o front deve exibir "Não foi possível carregar os campos disponíveis. Tente novamente."
    And o botão "Salvar" deve permanecer desabilitado até o schema carregar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Marca campos |
| Referência inexistente/inativa | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um {campo} válido." | Recarrega opções |
| Versão não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão não pode mais ser editada." | Oferece "Criar novo rascunho" |
| `If-Match` ausente/divergente | 428/412 | `PRECONDITION_REQUIRED`/`VERSION_CONFLICT` | "Os dados foram alterados. Recarregue." | Recarrega recurso |
| Processo não encontrado/visível (teste) | 404 | `NOT_FOUND` | "Selecione um processo válido." | Limpa seleção |
| Operador fora da allowlist (teste) | 422 | `WORKFLOW_INVALID` | "Esta condição usa um operador não permitido." | Destaca o bloco da condição |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para editar regras." | Oculta ações de edição |

## Dependências
- **Stories:** US-041 (executor `evaluateRules`/`RuleContextV1` reaproveitado no dry-run); US-043 (etapas/transições e rascunho onde as regras vivem); US-045 (validação profunda na publicação, `WF_RULE_PATH_UNKNOWN`).
- **Decisões/ADRs:** DEC-016, DEC-014, DEC-024, DEC-104, DEC-105; ADR-005, ADR-008.
- **Configurações:** nenhuma específica.
- **Lacunas nas fontes canônicas:** nenhuma ("Testar regra" cadastrado como `WF-23` em api.md §3.10).

## Impacto técnico
- O endpoint de teste de regra (`WF-23`) deve reaproveitar o mesmo `RuleEvaluator` do motor de runtime (US-041) para garantir que "testar" e "executar de verdade" nunca divirjam; recebe a `config` solta (não um `ruleId`), então não pode assumir que a regra existe no banco.
- Construtor de condições gera JSON Logic client-side (construtor próprio, sem dependência nova); a API sempre revalida a allowlist de operadores antes de qualquer execução (nunca confia no front).
- `config` é `jsonb` livre por tipo (§5.5 do pacote); validação de forma usa um schema Zod discriminado por `type`, compartilhado entre `WF-16`, `WF-17` e o endpoint de teste.

## Backend
- **Módulo(s):** `workflow` (dono); usa `access` (`AuthorizationService`), `process`/`document`/`risk` só leitura via `RuleContextV1` (no teste).
- **Casos de uso:** `CreateWorkflowRuleCommand`, `UpdateWorkflowRuleCommand`, `DeleteWorkflowRuleCommand`, `TestWorkflowRuleQuery` → handlers correspondentes.
- **Domínio:** `WorkflowRule` (entidade); `RuleConfigSchema` (union discriminada por `type`); reaproveita `RuleEvaluator`/`RuleContextV1` de US-041.
- **Integrações internas:** `WorkflowFacade.evaluateRules` (US-041) chamado pelo caso de uso de teste com uma regra avulsa em vez de uma lista persistida.
- **Transação:** `WF-16`/`WF-17`/`WF-18` em transação curta com `app.tenant_id`; o endpoint de teste é somente leitura, sem transação de escrita.

## Frontend
- **Tela(s):** SCR-035 (`/admin/workflows/[id]/regras`).
- **Componentes:** `RuleList` (por etapa/transição, com `displayOrder` arrastável), `RuleTypeSelect`, `RequiredDocumentFields`, `RequiredFieldPicker` (opções de `WF-19`), `RequiredApprovalFields`, `ConditionBuilder` (construtor próprio — combinador E/OU e linhas campo/operador/valor, alternativa em JSON), `RuleTestPanel` (busca de processo + resultado).
- **Estados:** skeleton ao carregar schema/regras; vazio ("Nenhuma regra configurada para esta etapa"); erro com "Tentar novamente"; resultado do teste com destaque de cor (satisfeita/não satisfeita).
- **Acessibilidade e responsividade:** construtor navegável por teclado; resultado do teste anunciado via `aria-live`; lista de regras em coluna única abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_rules` (escrita); leitura de `workflow_stages`, `workflow_transitions`, `document_types` e, no teste, `processes`/documentos/pesquisa de preços/riscos para montar o `RuleContext`.
- **Migrações:** nenhuma (tabela já definida em US-040/entities.md §4).
- **Índices/constraints relevantes:** check `(scope='STAGE_EXIT' AND stage_id IS NOT NULL AND transition_id IS NULL) OR (scope='TRANSITION' AND transition_id IS NOT NULL AND stage_id IS NULL)` (entities.md).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-16 | POST | `/api/v1/workflow-versions/{versionId}/rules` | `{ scope, stageId?, transitionId?, type, name, description?, severity, config, message, isActive?, displayOrder? }` | `201 { data: WorkflowRule }` | 201, 403, 409, 422 |
| WF-17 | PATCH | `/api/v1/workflow-rules/{ruleId}` | campos acima (parcial) + `If-Match` | `200 { data: WorkflowRule }` | 200, 403, 409, 412, 422, 428 |
| WF-18 | DELETE | `/api/v1/workflow-rules/{ruleId}` | `If-Match` | `204` | 204, 403, 409, 412, 428 |
| WF-19 | GET | `/api/v1/rule-context/schema` | — | `200 { data: { version: 1, fields: [{ path, label, type }] } }` | 200 |
| WF-23 | POST | `/api/v1/workflow-versions/{versionId}/rules/test` | `{ type, config, severity?, processId }` | `200 { data: { satisfied, severity, message, contextUsed } }` | 200, 403, 404, 422 |
| PRC-01 | GET | `/api/v1/processes?q=` | — | `200 { data: Process[] }` | 200 |

## Logs
- `info` `workflow.rule_saved` — `workflowVersionId`, `ruleId`, `type`, operação (create/update/delete).
- `info` `workflow.rule_tested` — `workflowVersionId`, `ruleType`, `processId`, `satisfied`, `durationMs` (sem conteúdo do processo).
- `warn` `workflow.rule_path_unknown` — caminho de `REQUIRED_FIELD`/`CONDITION` fora do schema no momento do teste.
- `error` `workflow.rule_write_failed` — causa, `correlationId`.
- **Nunca logar:** conteúdo de documentos, valores estimados, justificativas do processo usado no teste.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | Criar/editar/excluir regra | `metadata`: `ruleId`, `type`, `scope`, `stageId`/`transitionId` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_MANAGE` |

## Testes necessários
- **Unitários:** schema discriminado de `config` por `type` (RN-WF-55..58); exclusividade de âmbito (RN-WF-53); executor de `CONDITION` com allowlist.
- **Integração (Testcontainers):** criação/edição/exclusão respeitando `DRAFT`; endpoint de teste contra processo real sem persistir nada; RLS isola regras por tenant.
- **Concorrência:** duas edições simultâneas da mesma regra → uma 200, outra 412 `VERSION_CONFLICT`.
- **API/contrato:** respostas conforme tabela API; `If-Match`/`ETag` consistentes.
- **RBAC e multi-tenant:** `WORKFLOW_VIEW` vs `WORKFLOW_MANAGE`; teste com processo de outro tenant → 404.
- **E2E (Playwright):** criar regra `REQUIRED_DOCUMENT`, testá-la contra um processo, salvar e confirmar no checklist (`PRC-09`, US-041).
- **Acessibilidade/performance:** axe no construtor de condições; endpoint de teste com p95 < 400 ms.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md (incluindo `WF-23`)
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — quatro tipos de regra com configuração própria, construtor de condições e um fluxo de teste (dry-run) novo, mas sem mudanças de modelo (reaproveita entidades de US-040) nem workflow transacional complexo.

## Prioridade
**P1** — o motor (US-041) e o editor (US-043) já funcionam sem regras configuráveis pela UI; importante para o MVP 1, mas não bloqueia o fluxo padrão semeado (US-042).
