---
id: US-040
title: "Modelo de definição de workflow versionado"
epic: EP-007
feature: FT-028
mvp: 1
priority: P0
estimate: L
status: Especificada
depends_on: [US-061, US-100]
modules: [workflow, document, access, organization, identity, audit, platform]
screens: []
endpoints: [WF-02, WF-03, WF-04, WF-07, WF-08, WF-09, WF-10, WF-11, WF-12, WF-13, WF-14, WF-15, WF-16, WF-17, WF-18]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE]
events: [WorkflowCreated, WorkflowVersionPublished, WorkflowVersionRetired]
---

# US-040 — Modelo de definição de workflow versionado

## Título
Modelar a definição de workflow versionada, validável e imutável após a publicação

## Descrição
**Como** administrador do órgão (e como time que implementa o motor de tramitação), **quero** um modelo declarativo de workflow — workflow, versões, etapas, transições e regras — com validação completa do grafo e imutabilidade garantida após a publicação, **para** configurar o fluxo das contratações do meu órgão sem código e ter a certeza de que processos em andamento nunca terão as regras alteradas "por baixo".

Esta story entrega o **back-end do modelo de definição** (módulo `workflow`): entidades, migrações, RLS, FKs compostas, triggers de imutabilidade, os endpoints de manutenção de rascunho (WF-02 a WF-04 e WF-07 a WF-18), o validador de grafo (`WorkflowDefinitionValidator`), a montagem do snapshot canônico com `definitionHash` e o serviço interno de publicação (`WorkflowVersionPublisher`). A interface do editor é a US-043; regras com construtor visual, a US-044; validar/publicar/aposentar pela interface, a US-045; o motor de execução que consome a definição, a US-041; os workflows semeados, a US-042.

## Contexto
- Cada ente regulamenta a fase preparatória de um jeito (quem aprova, em que ordem, com quais documentos). DEC-014 define o motor próprio, declarativo e versionado: `Workflow` → `WorkflowVersion` (`DRAFT` → `PUBLISHED` → `RETIRED`; publicada é **imutável**) → `WorkflowStage` (`START`, `TASK`, `APPROVAL`, `END`) → `WorkflowTransition` (`FORWARD`, `RETURN`, `APPROVE`, `REJECT`, `COMPLETE`) → `WorkflowRule`.
- O processo fixa a versão do workflow na criação (`Process.workflowVersionId`, imutável — US-001); por isso a imutabilidade da versão publicada é requisito de conformidade, não detalhe técnico (DEC-084: snapshot canonicalizado RFC 8785 + SHA-256 + trigger).
- Regras parametrizáveis em JSON Logic sobre o `RuleContext v1` (DEC-016, entities.md §5.4/§5.5); somente caminhos do schema podem ser usados, validados na publicação.
- Dois workflows são semeados no provisionamento (DEC-015 e entities.md §7 — US-042) e **dependem desta story** para serem validados e publicados sem passar pela API de administração (P1).
- Consumidores: US-041 (motor), US-042 (seeder e aplicabilidade), US-043/US-044/US-045/US-046 (administração), US-001 e US-047 (criação e tramitação).

## Objetivo
Garantir que 100% das versões publicadas: (a) passaram pelo validador sem erros; (b) têm `definitionSnapshot` canônico e `definitionHash` reprodutível (recalcular o hash do snapshot gera o mesmo valor); (c) não podem ser alteradas por nenhum caminho (API, serviço ou SQL direto do papel da aplicação). O validador deve reportar **todos** os problemas de uma versão em uma única chamada, em menos de 200 ms (p95) para versões de até 50 etapas.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, escopo `TENANT`).
- **Secundárias:** Gestor de contratações (`GESTOR_CONTRATACOES`, possui `WORKFLOW_MANAGE`); time de engenharia (consumidores da fachada `WorkflowFacade`); perfis com `WORKFLOW_VIEW` (`PLANEJAMENTO`, `COMPRAS`, `LICITACOES`, `CONTROLE_INTERNO`, `AUTORIDADE_COMPETENTE`, `AUDITOR`) em leitura.

## Pré-condições
- Contexto de tenant e isolamento operacionais (US-100); persistência com concorrência otimista (US-081); outbox (US-082) e auditoria (US-073).
- Tipos de documento do tenant disponíveis pela fachada do módulo `document` (US-061) — necessários para validar `documentTypeCodes`, `approvalDocumentTypeCodes` e `REQUIRED_DOCUMENT`.
- Schema `ruleContextSchema` (RuleContext v1) e `workflowRuleConfigSchema` publicados em `packages/validation`.
- Usuário autenticado com vínculo ativo; para escrita, `WORKFLOW_MANAGE` (risco `H` — MFA conforme `security.mfaPolicy`).

## Fluxo principal
1. O administrador cria um workflow (`POST /workflows` — WF-02) informando `key`, `name`, `description` e, opcionalmente, `copyFromVersionId` (versão publicada do próprio tenant).
2. A API, em uma transação: valida o corpo; cria `Workflow` (`isActive = true`, `isDefault = false`, `applicabilityPriority = 100`) e a `WorkflowVersion` nº 1 em `DRAFT` — vazia ou com a cópia integral da versão de origem (RN-WF-22); grava `AuditLog` `workflow.create` e o evento `WorkflowCreated`; responde **201** com `Location` e `ETag`.
3. O administrador adiciona etapas (`POST /workflow-versions/{versionId}/stages` — WF-10). A API valida os campos condicionais por tipo (RN-WF-08); se a etapa for `START`, preenche `WorkflowVersion.initialStageId` (RN-WF-07); incrementa `WorkflowVersion.version` (RN-WF-06); audita `workflow.update`.
4. O administrador adiciona transições (WF-13), informando origem, destino e ação. A API aplica as validações locais (mesma versão, origem ≠ destino, compatibilidade ação × tipo — RN-WF-09/RN-WF-10) e força `requiresComment = true` em `RETURN`/`REJECT`.
5. O administrador adiciona regras (WF-16). A API valida `config` pelo schema do tipo (entities.md §5.5), os caminhos do RuleContext v1 e a whitelist de operações JSON Logic (RN-WF-17).
6. Alterações e exclusões (WF-11/12, WF-14/15, WF-17/18) exigem `If-Match` da linha; exclusão de etapa só em `DRAFT` e restritiva — bloqueada enquanto transições ou regras a referenciarem (RN-WF-50, US-043, que substituiu a cascata original).
7. A qualquer momento, o validador completo (`WorkflowDefinitionValidator.validate(versionId)`) avalia o grafo e devolve `errors[]` e `warnings[]` agrupados por etapa/transição/regra (exposto pelo WF-20 na US-045).
8. Na publicação (WF-21 na US-045, ou seeder da US-042), o `WorkflowVersionPublisher`, em uma transação com `SELECT … FOR UPDATE` na versão: revalida; monta o snapshot canônico; calcula `definitionHash`; muda a versão para `PUBLISHED` (`publishedAt`, `publishedById`); aponta `Workflow.currentPublishedVersionId` para ela; muda a publicada anterior para `RETIRED`; grava auditoria (`workflow.version_publish`, `workflow.version_retire`) e eventos (`WorkflowVersionPublished`, `WorkflowVersionRetired`).
9. Para evoluir o fluxo, o administrador cria nova versão (`POST /workflows/{id}/versions` — WF-08); a API clona a versão de origem (padrão: a publicada atual) em `DRAFT` nº N+1 (RN-WF-22). Processos em andamento continuam na versão que fixaram.

## Fluxos alternativos
- **FA-01 — Cópia de outro workflow:** com `copyFromVersionId` de versão `PUBLISHED`/`RETIRED` de outro workflow do tenant, a v1 nasce com a definição copiada (novos IDs). Versão de origem `DRAFT` ou de outro tenant → 422 `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`).
- **FA-02 — Já existe rascunho:** WF-08 com uma versão `DRAFT` existente → 409 `WORKFLOW_DRAFT_EXISTS` com `meta.draftVersionId`; a UI oferece "Abrir rascunho existente".
- **FA-03 — Etapa inicial trocada:** mudar o tipo da etapa `START` para outro tipo limpa `initialStageId`; criar outra `START` com uma já existente → 422 (RN-WF-07).
- **FA-04 — Exclusão de etapa referenciada:** excluir etapa referenciada por regra `REQUIRED_APPROVAL` de outra etapa é permitido no rascunho; o validador acusa `WF_RULE_SCOPE_INVALID` até a regra ser corrigida.
- **FA-05 — Tipo de documento desativado depois da escrita:** a escrita aceitou o código, mas o tipo foi desativado (US-061); o validador acusa `WF_DOCUMENT_TYPE_UNKNOWN` e bloqueia a publicação.
- **FA-06 — Tentativa de alterar versão publicada:** qualquer escrita em etapa/transição/regra de versão `PUBLISHED`/`RETIRED` → 409 `WORKFLOW_VERSION_NOT_DRAFT`; a UI oferece "Criar nova versão a partir desta".
- **FA-07 — Leitura de versão publicada:** WF-09 de versão publicada é servido a partir do `definitionSnapshot` (cache imutável por `workflowVersionId`); de rascunho, a partir das tabelas.

## Regras de negócio
- **RN-WF-01** — A definição pertence ao módulo `workflow` (DEC-040) e ao tenant (`tenant_id` + RLS). Hierarquia: `Workflow` 1:N `WorkflowVersion` 1:N (`WorkflowStage`, `WorkflowTransition`, `WorkflowRule`). Workflows não são excluídos: são desativados (`isActive = false` — US-042/US-045).
- **RN-WF-02** — `Workflow.key`: `^[A-Z][A-Z0-9_]{2,59}$`, única no tenant e **imutável**; `name` 3–150 caracteres; `description` até 2.000.
- **RN-WF-03** — Criar workflow cria, na mesma transação, a versão nº 1 em `DRAFT`, vazia ou copiada de `copyFromVersionId` (versão `PUBLISHED`/`RETIRED` do mesmo tenant).
- **RN-WF-04** — No máximo **uma versão `DRAFT` por workflow** (índice único parcial); `versionNumber` sequencial por workflow, sem reaproveitamento.
- **RN-WF-05** — Etapas, transições e regras só podem ser criadas, alteradas ou excluídas em versão `DRAFT` (validação na aplicação + trigger no banco); caso contrário, 409 `WORKFLOW_VERSION_NOT_DRAFT`.
- **RN-WF-06** — Toda escrita em etapa, transição ou regra incrementa `WorkflowVersion.version` na mesma transação (a versão é o `ETag` usado na publicação — US-045), além do `version` da própria linha.
- **RN-WF-07** — `initialStageId` é **derivado**: aponta para a etapa `START` da versão (não é campo editável). Na escrita, no máximo uma `START` por versão; na validação, exatamente uma.
- **RN-WF-08** — Campos condicionais da etapa: `approverType` obrigatório se `APPROVAL` e nulo nos demais tipos; `approverUserId` se `USER`; `approverRoleId` se `ROLE`; `approverDepartmentResolution` ∈ {`FIXED`, `REQUESTING_SECRETARIAT`, `REQUESTING_DEPARTMENT`} se `DEPARTMENT_HEAD` (+ `approverFixedDepartmentId` se `FIXED`); `approvalDocumentTypeCodes` só em `APPROVAL`; `fixedDepartmentId` se `departmentResolution = FIXED`; `START` não usa `CHOSEN_ON_FORWARD`; `END` sem SLA; `slaDays` 1–365; `color` `#RRGGBB`.
- **RN-WF-09** — Transições: origem e destino da **mesma versão** (FK composta), origem ≠ destino, unicidade `(from, to, action)` e de `key` na versão; `requiresComment` forçado `true` em `RETURN` e `REJECT`.
- **RN-WF-10** — Compatibilidade ação × tipo de etapa: `FORWARD` sai de `START`/`TASK` para `TASK`/`APPROVAL`; `COMPLETE` sai de `START`/`TASK` para `END`; `APPROVE` sai de `APPROVAL` para `TASK`/`APPROVAL`/`END`; `RETURN` e `REJECT` vão para etapa `START`/`TASK` **anterior** (existe caminho de avanço do destino até a origem); `END` não tem transições de saída.
- **RN-WF-11** — Alcançabilidade: toda etapa é alcançável a partir da `START` por transições de avanço (`FORWARD`, `APPROVE`, `COMPLETE`).
- **RN-WF-12** — Terminação: a partir de toda etapa existe caminho de avanço até uma etapa `END`; a versão tem ao menos uma `END`.
- **RN-WF-13** — Etapa `APPROVAL` tem exatamente uma transição `APPROVE`, ao menos uma `RETURN` e exatamente uma `REJECT` (destino da `REJECT` = etapa de origem — PEND-02).
- **RN-WF-14** — No máximo uma transição `isPrimary = true` por etapa de origem entre `FORWARD`/`COMPLETE`.
- **RN-WF-15** — Todo código em `documentTypeCodes`, `approvalDocumentTypeCodes` e `config.documentTypeCode` existe e está ativo no tenant (`DocumentType.code`).
- **RN-WF-16** — Aprovador resolvível: `USER` com vínculo `ACTIVE`; `ROLE` existente, ativo e com `APPROVAL_DECIDE`; `DEPARTMENT_HEAD`/`FIXED` com unidade ativa (sem titular → aviso). A cobertura do perfil é verificada em tempo de execução pela unidade solicitante (DEC-022 — US-041/US-051).
- **RN-WF-17** — Regras: `config` válido pelo schema do tipo (entities.md §5.5); `REQUIRED_FIELD.field` e variáveis de `CONDITION` restritos aos caminhos do RuleContext v1 (na escrita, `REQUIRED_FIELD.field` fora do schema é aceito no rascunho e só barrado na validação/publicação — RN-WF-56, US-044); `CONDITION` só com operações da whitelist (sem `method`/`log`), profundidade ≤ 20 e tamanho ≤ 10 KB; `REQUIRED_APPROVAL.stageKey` aponta para etapa `APPROVAL` da mesma versão; regras `TRANSITION` só em `FORWARD`/`COMPLETE`/`APPROVE`; `STAGE_EXIT` não se aplica a `END`.
- **RN-WF-18** — Limites por versão: 50 etapas, 200 transições, 200 regras; `instructions` até 5.000 caracteres (Markdown restrito).
- **RN-WF-19** — A validação completa reporta **todos** os erros (não para no primeiro), cada um com `code`, `stageKey`/`transitionKey`/`ruleId` e mensagem pt-BR; avisos (`warnings[]`) não bloqueiam a publicação.
- **RN-WF-20** — Publicação interna (`WorkflowVersionPublisher`): exige validação sem erros; snapshot canônico (arrays ordenados por `key`, RFC 8785) com SHA-256 em `definitionHash`; status `PUBLISHED` com `publishedAt`/`publishedById`; `Workflow.currentPublishedVersionId` atualizado; versão publicada anterior → `RETIRED` (supersedida); tudo atômico.
- **RN-WF-21** — Versão não `DRAFT` é imutável: o único update permitido é `PUBLISHED` → `RETIRED` (`retiredAt`, `retiredById`); `DELETE` de versão não `DRAFT` é bloqueado (trigger).
- **RN-WF-22** — Nova versão: `versionNumber = max + 1`; clona etapas, transições e regras da versão de origem (padrão: `currentPublishedVersionId`; sem publicada e sem origem informada → 422, RN-WF-47 da US-043) com **novos IDs** e referências remapeadas (`initialStageId`, `fromStageId`/`toStageId`, `stageId`/`transitionId`); `changeNotes` vazio; nenhum processo é afetado (DEC-014).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Chave do workflow | `Workflow.key` | texto | Sim | RN-WF-02; imutável | sugerida a partir do nome |
| Nome / Descrição | `Workflow.name` / `description` | texto | Sim / Não | 3–150 / ≤ 2.000 | — |
| Copiar de | `copyFromVersionId` | seleção | Não | versão `PUBLISHED`/`RETIRED` do tenant | — |
| Chave / Nome da etapa | `WorkflowStage.key` / `name` | texto | Sim | `^[A-Z][A-Z0-9_]{1,59}$`, única na versão / 3–150 | — |
| Orientações (próximo passo) | `instructions` | Markdown | Não | ≤ 5.000; links `https` | — |
| Tipo | `type` | `StageType` | Sim | RN-WF-07/08 | — |
| Grupo no stepper / Ordem | `groupLabel` / `displayOrder` | texto / int | Não / Sim | ≤ 60 / ≥ 0 | — / próximo |
| Unidade responsável | `departmentResolution` (+ `fixedDepartmentId`) | `DepartmentResolution` | Sim | RN-WF-08 | `REQUESTING_DEPARTMENT` |
| Responsável ao entrar | `assignmentPolicy` | `StageAssignmentPolicy` | Sim | — | `UNASSIGNED` |
| Aprovador | `approverType`, `approverUserId`, `approverRoleId`, `approverDepartmentResolution`, `approverFixedDepartmentId`, `allowDeputy` | — | Se `APPROVAL` | RN-WF-08/16 | `allowDeputy = true` |
| Documentos cobertos pela aprovação | `approvalDocumentTypeCodes` | lista de códigos | Não | só `APPROVAL`; RN-WF-15; máx. 20 | `{}` |
| Documentos permitidos na etapa | `documentTypeCodes` | lista de códigos | Não | vazio = todos; RN-WF-15; máx. 30 | `{}` |
| Prazo (SLA) | `slaDays` / `slaType` | int / `DayCountType` | Não | 1–365; `END` sem SLA | — / `BUSINESS` |
| Cor | `color` | `#RRGGBB` | Não | — | por tipo |
| Transição: chave, rótulo, descrição | `WorkflowTransition.key`, `name`, `description` | texto | Sim, Sim, Não | chave única; 3–150; ≤ 1.000 | — |
| Origem / Destino / Ação | `fromStageId` / `toStageId` / `action` | uuid / uuid / `TransitionAction` | Sim | RN-WF-09/10 | — |
| Principal, comentário, prazo editável | `isPrimary`, `requiresComment`, `allowDueDateOverride` | booleanos | Não | RN-WF-09/14 | `false`, `false`, `true` |
| Regra: escopo, alvo | `WorkflowRule.scope`, `stageId`/`transitionId` | `RuleScope` | Sim | check de escopo (entities.md §4.5) | — |
| Regra: tipo, nome, severidade, mensagem | `type`, `name`, `severity`, `message` | — | Sim | 3–150; `message` 5–500 | `BLOCKING` |
| Regra: configuração | `config` | jsonb | Sim | RN-WF-17 | — |
| Regra: ativa, ordem | `isActive`, `displayOrder` | bool / int | Não | — | `true` / `0` |
| *(sistema)* | `versionNumber`, `status`, `initialStageId`, `definitionSnapshot`, `definitionHash`, `publishedAt/ById`, `retiredAt/ById` | — | — | RN-WF-04/07/20/21 | gerados |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Formatos e tamanhos (chaves, nomes, Markdown, cor, SLA) | Front + API (Zod) | "Revise os campos destacados." | `VALIDATION_ERROR` (`INVALID_FORMAT`, `TOO_LONG`, `OUT_OF_RANGE`) |
| V-02 | Campos condicionais por tipo (RN-WF-08) | Front + API | "Informe o aprovador da etapa de aprovação." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`/`NOT_ALLOWED`) |
| V-03 | Segunda etapa `START` na versão | API | "A versão já possui uma etapa inicial." | `VALIDATION_ERROR` (`NOT_ALLOWED`, campo `type`) |
| V-04 | Chave de workflow/etapa/transição já usada | API (+ índice único) | "Já existe um item com a chave {key}." | `CONFLICT` |
| V-05 | Referência inexistente/inativa/de outro tenant ou de outra versão (unidade, usuário, perfil, etapa) | API | "Selecione um valor válido." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) |
| V-06 | Ação incompatível com os tipos de origem/destino (RN-WF-10) | API | "Esta ação não é permitida a partir de uma etapa {tipo}." | `VALIDATION_ERROR` (`NOT_ALLOWED`, campo `action`) |
| V-07 | `config` de regra inválido, caminho desconhecido ou operação proibida | API | "A condição usa um campo ou operação não permitidos." | `VALIDATION_ERROR` (campo `config`) |
| V-08 | Escrita em versão não `DRAFT` | API + trigger | "Esta versão já foi publicada e não pode ser alterada. Crie uma nova versão." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-09 | Segunda versão em rascunho | API (+ índice parcial) | "Já existe uma versão em rascunho deste workflow." | `WORKFLOW_DRAFT_EXISTS` (409, `meta.draftVersionId`) |
| V-10 | `If-Match` divergente / ausente | API | "Outra pessoa alterou este item. Recarregue para continuar." | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` |
| V-11 | Validação completa do grafo (RN-WF-11..19) | Domínio | Lista por etapa/transição/regra (tabela abaixo) | `WORKFLOW_INVALID` (`errors[]`) |

Códigos de `errors[].code` do `WORKFLOW_INVALID` (cada item traz `stageKey`, `transitionKey` ou `ruleId`):

| Código | Regra | Mensagem (pt-BR) |
|---|---|---|
| `WF_START_STAGE_COUNT` | RN-WF-07 | "O fluxo deve ter exatamente uma etapa inicial." |
| `WF_END_STAGE_MISSING` | RN-WF-12 | "O fluxo deve ter ao menos uma etapa final." |
| `WF_STAGE_UNREACHABLE` | RN-WF-11 | "A etapa {stageName} não pode ser alcançada a partir da etapa inicial." |
| `WF_END_UNREACHABLE` | RN-WF-12 | "A partir da etapa {stageName} não é possível chegar ao fim do fluxo." |
| `WF_APPROVAL_TRANSITIONS` | RN-WF-13 | "A etapa de aprovação {stageName} precisa de uma saída de aprovação, ao menos uma de devolução e uma de indeferimento." |
| `WF_ACTION_NOT_ALLOWED_FROM_STAGE` | RN-WF-10 | "A transição {transitionName} não é permitida a partir de uma etapa {tipo}." |
| `WF_TRANSITION_TARGET_INVALID` | RN-WF-10 | "O destino da transição {transitionName} é inválido para a ação escolhida." |
| `WF_PRIMARY_DUPLICATED` | RN-WF-14 | "A etapa {stageName} tem mais de uma ação principal." |
| `WF_DOCUMENT_TYPE_UNKNOWN` | RN-WF-15 | "O tipo de documento {code} não existe ou está inativo." |
| `WF_APPROVER_UNRESOLVABLE` | RN-WF-16 | "O aprovador da etapa {stageName} não pode ser determinado." |
| `WF_DEPARTMENT_INVALID` | RN-WF-08 | "A unidade configurada para a etapa {stageName} é inválida ou está inativa." |
| `WF_RULE_CONFIG_INVALID` / `WF_RULE_PATH_UNKNOWN` / `WF_RULE_OPERATOR_FORBIDDEN` / `WF_RULE_SCOPE_INVALID` | RN-WF-17 | "A regra {ruleName} está inválida: {detalhe}." |
| `WF_LIMIT_EXCEEDED` | RN-WF-18 | "O fluxo excede o limite de {limite} {itens}." |

Avisos (`warnings[]`): `WF_STAGE_NO_SLA` (etapa `TASK`/`APPROVAL` sem prazo), `WF_APPROVER_HEAD_MISSING` (unidade fixa sem titular), `WF_STAGE_NO_INSTRUCTIONS` (etapa sem orientação), `WF_RULE_INACTIVE` (regra inativa na versão).

## Permissões
- **Permissão:** `WORKFLOW_VIEW` para leituras (WF-03, WF-07, WF-09); `WORKFLOW_MANAGE` para escrita em rascunho (WF-02, WF-04, WF-08, WF-10 a WF-18). Permissões sem escopo de processo (escopos `TENANT`/`ORGANIZATION` considerados — permissions.md §1.1).
- **Políticas:** nenhuma política contextual de processo; estado da versão (RN-WF-05) aplicado no domínio e no banco.
- **MFA:** `WORKFLOW_MANAGE` é risco `H` → sessão com MFA quando `security.mfaPolicy ∈ {ADMINS, ALL}` (POL-14); senão 403 `MFA_REQUIRED` (step-up no BFF).
- **Sem permissão:** 403 `PERMISSION_DENIED` com auditoria `access.denied`; a área "Administração › Workflows e regras" não aparece sem `WORKFLOW_VIEW` (permissions.md §9).

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowCreated` | `workflow.created` | Commit do WF-02 (e do seeder — US-042) | Payload `workflowId`, `key` |
| `WorkflowVersionPublished` | `workflow.version_published` | Commit do `WorkflowVersionPublisher` (acionado pelo WF-21 — US-045 — ou pelo seeder) | `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash`; invalida caches (C) |
| `WorkflowVersionRetired` | `workflow.version_retired` | Versão supersedida na publicação (RN-WF-20) ou aposentada (WF-22) | `workflowId`, `workflowVersionId` |

Edições de rascunho (WF-04, WF-10 a WF-18) e criação de versão (WF-08) não geram eventos (api.md §3.10): ficam só na auditoria.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma: configuração não gera notificação (events.md §6). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Modelo de definição de workflow versionado

  Background:
    Given que o tenant "Prefeitura de São José" está ativo com a política de MFA "ADMINS"
    And o usuário "Rafael" possui o perfil "ADMIN_ORGAO" com escopo "TENANT" e sessão com MFA
    And os tipos de documento "DFD", "ETP" e "TR" estão ativos no tenant

  Scenario: [Sucesso] Criar workflow com a versão 1 em rascunho
    When "Rafael" enviar POST "/api/v1/workflows" com chave "OBRAS_ENGENHARIA" e nome "Obras e serviços de engenharia"
    Then a API deve responder 201 com "Location" e "ETag" igual a "1"
    And deve existir o workflow "OBRAS_ENGENHARIA" ativo, não padrão, com prioridade de aplicabilidade 100
    And deve existir a versão 1 com status "DRAFT" e sem etapas
    And deve gerar registro de auditoria "workflow.create"
    And deve gerar o evento "WorkflowCreated"

  Scenario: [Sucesso] Etapa inicial define a etapa de entrada da versão
    Given o rascunho v1 do workflow "OBRAS_ENGENHARIA"
    When "Rafael" criar a etapa "ABERTURA" do tipo "START" com unidade "REQUESTING_DEPARTMENT"
    Then "initialStageId" da versão deve apontar para "ABERTURA"
    And o "version" da versão deve ser incrementado
    And deve gerar registro de auditoria "workflow.update" com entityType "WorkflowStage"

  Scenario: [Sucesso] Publicação interna gera snapshot canônico e hash reprodutível
    Given um rascunho com as etapas "ABERTURA" (START), "ANALISE" (TASK), "APROVACAO" (APPROVAL) e "FIM" (END) e transições válidas
    When o serviço de publicação publicar o rascunho
    Then a versão deve ficar "PUBLISHED" com "publishedAt", "definitionSnapshot" e "definitionHash" preenchidos
    And recalcular o SHA-256 do snapshot canonicalizado (RFC 8785) deve produzir o mesmo "definitionHash"
    And "currentPublishedVersionId" do workflow deve apontar para a nova versão
    And devem ser gerados o evento "WorkflowVersionPublished" e a auditoria "workflow.version_publish"

  Scenario: [Sucesso] Nova versão clona a publicada com novos identificadores
    Given que a v1 publicada tem 4 etapas, 6 transições e 3 regras
    When "Rafael" enviar POST "/api/v1/workflows/{id}/versions"
    Then deve ser criada a versão 2 em "DRAFT" com 4 etapas, 6 transições e 3 regras
    And nenhum identificador da v2 deve coincidir com os da v1
    And "initialStageId", origens, destinos e alvos das regras da v2 devem apontar para itens da própria v2
    And deve gerar registro de auditoria "workflow.version_create"

  Scenario: [Validação] Grafo com etapa inalcançável e aprovação incompleta
    Given um rascunho em que a etapa "PARECER" não recebe nenhuma transição de avanço
    And a etapa "APROVACAO" não possui transição "REJECT"
    When o validador for executado
    Then o resultado deve conter o erro "WF_STAGE_UNREACHABLE" com stageKey "PARECER"
    And deve conter o erro "WF_APPROVAL_TRANSITIONS" com stageKey "APROVACAO"
    And todos os erros devem ser retornados em uma única execução

  Scenario: [Validação] Condição com operação proibida e campo fora do contexto
    When "Rafael" criar uma regra "CONDITION" com expressão {"method": [{"var": "process.title"}, "toUpperCase"]}
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro no campo "config"
    When "Rafael" criar uma regra "REQUIRED_FIELD" com o campo "process.internalCode"
    Then a API deve responder 422 informando que o campo não pertence ao RuleContext v1

  Scenario: [Validação] Segunda etapa inicial
    Given que o rascunho já possui a etapa "ABERTURA" do tipo "START"
    When "Rafael" criar a etapa "NOVA_ABERTURA" do tipo "START"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED" no campo "type"

  Scenario: [Permissão] Usuário sem WORKFLOW_MANAGE
    Given que "Marcos" possui apenas o perfil "PLANEJAMENTO" (com "WORKFLOW_VIEW")
    When "Marcos" enviar GET "/api/v1/workflow-versions/{versionId}"
    Then a API deve responder 200 com a definição da versão
    When "Marcos" enviar POST "/api/v1/workflow-versions/{versionId}/stages"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied" com reasonCode "WORKFLOW_MANAGE"

  Scenario: [Permissão] Escrita sem MFA quando a política exige
    Given que a sessão de "Rafael" não possui MFA
    When "Rafael" enviar PATCH "/api/v1/workflow-stages/{stageId}"
    Then a API deve responder 403 com código "MFA_REQUIRED"

  Scenario: [Tenant incorreto] Versão e etapa de outro tenant
    Given que existe uma versão de workflow no tenant "Prefeitura B"
    When "Rafael" enviar GET para essa versão
    Then a API deve responder 404 sem revelar a existência do recurso
    When "Rafael" criar uma transição cujo destino é uma etapa do tenant "Prefeitura B"
    Then a API deve responder 422 com erro "REFERENCE_NOT_FOUND" no campo "toStageId"

  Scenario: [Duplicidade] Segunda versão em rascunho e chave repetida
    Given que o workflow "OBRAS_ENGENHARIA" já possui a versão 2 em "DRAFT"
    When "Rafael" solicitar uma nova versão
    Then a API deve responder 409 com código "WORKFLOW_DRAFT_EXISTS" e "meta.draftVersionId" da versão 2
    When "Rafael" criar outro workflow com a chave "OBRAS_ENGENHARIA"
    Then a API deve responder 409 com código "CONFLICT"

  Scenario: [Concorrência] Duas pessoas alteram a mesma etapa
    Given que "Rafael" e "Patrícia" carregaram a etapa "ANALISE" com ETag "3"
    When "Rafael" salvar o prazo de 10 dias com If-Match "3"
    And "Patrícia" salvar o nome "Análise técnica" com If-Match "3"
    Then a primeira alteração deve ser aplicada e a segunda deve receber 412 "VERSION_CONFLICT"

  Scenario: [Concorrência] Edição concorrente com a publicação
    Given que a publicação da v2 está em andamento com bloqueio da versão
    When "Patrícia" tentar excluir uma transição da v2
    Then após a publicação a exclusão deve ser rejeitada com 409 "WORKFLOW_VERSION_NOT_DRAFT"
    And o "definitionSnapshot" publicado deve conter a transição

  Scenario: [Falha de banco] Trigger impede alteração direta em versão publicada
    Given a v1 publicada do workflow "OBRAS_ENGENHARIA"
    When o papel da aplicação executar UPDATE em "workflow_stages" de uma etapa da v1
    Then o banco deve rejeitar a operação e nenhuma linha deve ser alterada
    And um UPDATE do "definitionHash" da v1 também deve ser rejeitado

  Scenario: [Falha de banco] Banco indisponível ao criar workflow
    Given que o banco fica indisponível durante a transação do WF-02
    When "Rafael" criar um workflow
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e "Retry-After"
    And nenhum workflow, versão, auditoria ou evento deve ser persistido

  Scenario: [Falha de integração] Redis indisponível para o cache de definições
    Given que o Redis está indisponível
    When o motor solicitar a definição da v1 publicada
    Then a definição deve ser lida do "definitionSnapshot" no banco
    And deve ser registrado log "warn" "workflow.definition_cache_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Corpo inválido | 422 | `VALIDATION_ERROR` | "Revise os campos destacados." | Destaca campos (`errors[]`) |
| Referência inválida (unidade, usuário, perfil, etapa) | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`/`REFERENCE_INACTIVE`) | "Selecione um valor válido." | Recarrega opções |
| Chave duplicada / segundo rascunho | 409 | `CONFLICT` | "Já existe um item com a chave {key}." / "Já existe uma versão em rascunho." | Erro no campo / "Abrir rascunho existente" |
| Versão não editável | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão já foi publicada e não pode ser alterada." | Modo leitura + "Criar nova versão" |
| Grafo inválido na publicação | 422 | `WORKFLOW_INVALID` | "O fluxo tem {n} problemas que impedem a publicação." | Lista por etapa/transição (US-045) |
| Sem permissão / sem MFA | 403 | `PERMISSION_DENIED` / `MFA_REQUIRED` | "Você não tem permissão para editar workflows." / "Confirme sua identidade para continuar." | Oculta ações / step-up |
| Inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Workflow não encontrado." | SCR-111 404 |
| Conflito de edição / sem `If-Match` | 412 / 428 | `VERSION_CONFLICT` / `PRECONDITION_REQUIRED` | "Outra pessoa alterou este item. Recarregue." | Diálogo de recarga |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível salvar agora. Tente novamente." | Mantém formulário; mostra correlationId |
| Erro inesperado | 500 | `INTERNAL_ERROR` | "Ocorreu um erro inesperado. Código: {correlationId}." | Botão copiar código |

## Dependências
- **Stories:** US-061 (tipos de documento), US-100 (tenant e RLS). Indiretas: US-073 (auditoria), US-081 (Prisma/`version`), US-082 (outbox), US-097 (autorização/MFA), US-094 (perfis para `approverRoleId`), US-102 (unidades para `FIXED`).
- **Consumidores:** US-041, US-042, US-043, US-044, US-045, US-046.
- **Decisões/ADRs:** DEC-014, DEC-015, DEC-016, DEC-022, DEC-040, DEC-041, DEC-055, DEC-081, DEC-082, DEC-084, DEC-104; ADR-005, ADR-008.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** (1) códigos `WF_*` de `errors[]`/`warnings[]` do `WORKFLOW_INVALID` — catalogados em api.md §2.3 (membro `validation`); (2) não há código específico para chave duplicada — adotado `CONFLICT` (409); "rascunho já existente" usa `WORKFLOW_DRAFT_EXISTS` (api.md §2.2); (3) não há rota para descartar rascunho de versão — propor `DELETE /workflow-versions/{versionId}` (somente `DRAFT`); (4) a coluna "Story" do api.md §3.10 inclui a US-040 em WF-02..04 e WF-07..18; (5) não há ações de auditoria granulares para etapa/transição/regra — adotado `workflow.update` com `entityType`.

## Impacto técnico
- Estabelece o padrão de **definição imutável com snapshot e hash** (reutilizável por templates — US-108) e o validador de grafo usado em escrita, validação (WF-20), publicação (WF-21) e seed (US-042).
- FKs compostas com a versão (`(tenant_id, workflow_version_id, id)`) garantem no banco que transições e regras nunca apontem para etapas de outra versão ou tenant.
- `initialStageId` e `currentPublishedVersionId` são FKs circulares → `DEFERRABLE INITIALLY DEFERRED`.
- O motor (US-041) lê a definição do snapshot (1 linha, cache imutável por `workflowVersionId`), nunca das tabelas, evitando N consultas por requisição.
- Algoritmos do validador: BFS a partir da `START` (alcançabilidade) e BFS reversa a partir das `END` (terminação), O(E + V); "anterior" (RN-WF-10) calculado por fecho transitivo das arestas de avanço.

## Backend
- **Módulo(s):** `workflow` (dono). Fachadas consumidas: `DocumentFacade.listActiveTypeCodes()` (US-061), `OrganizationFacade.getDepartments(ids)`, `AccessFacade.getRoles(ids)` (com permissões), `IdentityFacade.getActiveMemberships(userIds)`, `AuditService`, `OutboxWriter`.
- **Casos de uso:** `CreateWorkflowCommand`, `UpdateWorkflowCommand` (campos básicos; aplicabilidade na US-042), `CreateWorkflowVersionCommand` (clone), `Create/Update/DeleteWorkflowStageCommand`, `Create/Update/DeleteWorkflowTransitionCommand`, `Create/Update/DeleteWorkflowRuleCommand`, `GetWorkflowQuery`, `ListWorkflowVersionsQuery`, `GetWorkflowVersionQuery`.
- **Domínio:** agregado `WorkflowVersion` (etapas, transições e regras como entidades internas); `WorkflowDefinitionValidator` (puro; recebe definição + catálogos de referência); `WorkflowSnapshotBuilder` (canonicalização RFC 8785 via `canonicalize` + SHA-256); `WorkflowVersionPublisher` (serviço de aplicação interno, exportado pela fachada para US-042/US-045); `JsonLogicWhitelist` compartilhada com o avaliador da US-041.
- **Transação:** cada comando de escrita: `SELECT … FOR UPDATE` na `workflow_versions` (verifica `DRAFT`) → escrita → incremento de `version` da versão → `AuditService` → commit. Publicação: bloqueio da versão e do workflow → validação → snapshot/hash → updates → auditoria → outbox → commit.
- **Cache:** definição publicada em Redis `cf:{env}:t:{tenantId}:workflow:def:{workflowVersionId}` sem TTL relevante (24 h) por ser imutável; fallback ao banco.

## Frontend
- **Tela(s):** nenhuma nesta story (a interface é a US-043/US-044/US-045). Entrega para o front os schemas Zod compartilhados (`workflowStageSchema`, `workflowTransitionSchema`, `workflowRuleConfigSchema`) e os tipos gerados do OpenAPI.
- **Componentes:** —
- **Estados:** —
- **Acessibilidade e responsividade:** mensagens de validação em pt-BR, sem códigos técnicos (DEC-184); o `code` é usado pela UI apenas para ícones e links.

## Banco de dados
- **Tabelas:** `workflows`, `workflow_versions`, `workflow_stages`, `workflow_transitions`, `workflow_rules` (entities.md §4.5) + `audit_logs`, `outbox_events`.
- **Migrações:** criação das 5 tabelas com colunas padrão, RLS `ENABLE`+`FORCE`, `UNIQUE (tenant_id, id)`; `UNIQUE (tenant_id, workflow_version_id, id)` em etapas e transições; FKs compostas `(tenant_id, workflow_version_id, from_stage_id|to_stage_id|stage_id) → workflow_stages (tenant_id, workflow_version_id, id)` e `(tenant_id, workflow_version_id, transition_id) → workflow_transitions (…)`; `ON DELETE CASCADE` de etapas → transições/regras; FKs deferíveis `initial_stage_id` e `current_published_version_id`.
- **Triggers (SQL bruto):** `trg_wf_definition_immutable` (BEFORE INSERT/UPDATE/DELETE em etapas, transições e regras: rejeita se a versão não for `DRAFT`); `trg_wf_version_immutable` (BEFORE UPDATE/DELETE em `workflow_versions`: fora de `DRAFT`, só permite `PUBLISHED`→`RETIRED` com `retired_at`/`retired_by_id`/`version`/`updated_*`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)` em `workflows`; `UNIQUE (tenant_id) WHERE is_default`; `UNIQUE (tenant_id, workflow_id, version_number)`; `UNIQUE (tenant_id, workflow_id) WHERE status = 'DRAFT'`; checks de entities.md §4.5; `CHECK (status = 'DRAFT' OR (definition_snapshot IS NOT NULL AND definition_hash IS NOT NULL AND published_at IS NOT NULL AND initial_stage_id IS NOT NULL))`; `CHECK (status <> 'RETIRED' OR retired_at IS NOT NULL)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-02 | POST | `/api/v1/workflows` | `{ key, name, description?, copyFromVersionId? }` + `Idempotency-Key` | `201 { data: Workflow & { draftVersion { id, versionNumber } } }` | 201, 403, 409, 422 |
| WF-03 | GET | `/api/v1/workflows/{id}` | — | `200 { data: { id, key, name, description, isActive, isDefault, applicabilityRule, applicabilityPriority, currentPublishedVersion?, draftVersion? } }` + `ETag` | 200, 404 |
| WF-04 | PATCH | `/api/v1/workflows/{id}` | `{ name?, description?, isActive?, applicabilityRule?, applicabilityPriority? }` + `If-Match` | `200 { data: Workflow }` | 200, 409, 412, 422, 428 |
| WF-07 | GET | `/api/v1/workflows/{id}/versions` | `?page&pageSize` | lista de versões (número, status, datas, autores, `definitionHash`) | 200, 404 |
| WF-08 | POST | `/api/v1/workflows/{id}/versions` | `{ sourceVersionId? }` | `201 { data: WorkflowVersion }` | 201, 409, 422 |
| WF-09 | GET | `/api/v1/workflow-versions/{versionId}` | — | `200 { data: { id, versionNumber, status, initialStageId, stages[], transitions[], rules[], definitionHash? } }` + `ETag` | 200, 404 |
| WF-10/11/12 | POST/PATCH/DELETE | `/workflow-versions/{versionId}/stages`, `/workflow-stages/{stageId}` | campos da etapa; `If-Match` em PATCH/DELETE | `201/200 { data: WorkflowStage }` / 204 | 201, 200, 204, 409, 412, 422 |
| WF-13/14/15 | POST/PATCH/DELETE | `/workflow-versions/{versionId}/transitions`, `/workflow-transitions/{transitionId}` | campos da transição | idem | idem |
| WF-16/17/18 | POST/PATCH/DELETE | `/workflow-versions/{versionId}/rules`, `/workflow-rules/{ruleId}` | campos da regra (`config` por tipo) | idem | idem |

Exemplo de etapa (WF-10, `201`):
```json
{ "data": { "id": "0192…", "key": "APROVACAO_DFD", "name": "Aprovação da demanda", "type": "APPROVAL",
  "departmentResolution": "REQUESTING_SECRETARIAT", "assignmentPolicy": "UNASSIGNED",
  "approverType": "DEPARTMENT_HEAD", "approverDepartmentResolution": "REQUESTING_SECRETARIAT", "allowDeputy": true,
  "approvalDocumentTypeCodes": ["DFD"], "documentTypeCodes": ["DESPACHO", "DOCUMENTO_EXTERNO"],
  "slaDays": 3, "slaType": "BUSINESS", "displayOrder": 2, "version": 1 } }
```

## Logs
- `info` `workflow.created` / `workflow.version_created` — `workflowId`, `versionNumber`, `sourceVersionId?`, `tenantId`, `userId`, `correlationId`.
- `info` `workflow.version_published` — `workflowVersionId`, `definitionHash`, `stagesCount`, `transitionsCount`, `rulesCount`, `durationMs`.
- `info` `workflow.validation_completed` — `workflowVersionId`, `errorsCount`, `warningsCount`, `durationMs`.
- `warn` `workflow.definition_cache_unavailable` — fallback ao banco.
- `error` `workflow.immutability_violation_attempt` — tentativa de escrita em versão não `DRAFT` barrada pelo trigger (indica bug).
- **Nunca logar:** expressões JSON Logic completas e textos de orientação em nível `info` (apenas tamanho/hash).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.create` | `CONFIGURATION` | WF-02 | `changes`: `key`, `name`; `metadata`: `copyFromVersionId?`, `draftVersionId` |
| `workflow.update` | `CONFIGURATION` | WF-04 e escrita em etapa/transição/regra (WF-10 a WF-18) | `entityType` (`Workflow`, `WorkflowStage`, `WorkflowTransition`, `WorkflowRule`), `changes` campo a campo (expressões como hash + tamanho), `metadata.workflowVersionId`, `metadata.operation` (`CREATE`/`UPDATE`/`DELETE`) |
| `workflow.version_create` | `CONFIGURATION` | WF-08 | `metadata`: `versionNumber`, `sourceVersionId` |
| `workflow.version_publish` / `workflow.version_retire` | `CONFIGURATION` | Publicador interno | `metadata`: `definitionHash`, `versionNumber`, `reason` (`SUPERSEDED`/`MANUAL`) |
| `access.denied` | `ACCESS` | Escrita sem permissão | `reasonCode = WORKFLOW_MANAGE` |

## Testes necessários
- **Unitários:** cada código `WF_*` do validador com caso positivo e negativo; compatibilidade ação × tipo (tabela completa); `WorkflowSnapshotBuilder` determinístico (ordem de inserção diferente → mesmo hash); clonagem com remapeamento de IDs; whitelist JSON Logic (rejeita `method`, `log`, operadores desconhecidos, profundidade > 20).
- **Property-based (fast-check):** gerador de grafos válidos (cadeia `START → … → END` com aprovações e devoluções aleatórias) sempre aceito pelo validador; mutações dirigidas (remover `REJECT`, desconectar etapa, criar ciclo sem saída para `END`) sempre rejeitadas com o código esperado; `hash(clone(v))` difere apenas pelos IDs (snapshot sem IDs é idêntico).
- **Integração (Testcontainers):** triggers bloqueiam INSERT/UPDATE/DELETE em versões publicadas, inclusive por SQL direto do papel da aplicação; FK composta impede transição entre versões; índice parcial impede dois rascunhos; RLS isola tenants; publicação atômica (falha induzida após o hash → nada muda).
- **API/contrato:** WF-02..04, WF-07..18 conforme api.md; `ETag`/`If-Match`; `Location`; `Idempotent-Replayed`.
- **RBAC e multi-tenant:** matriz `WORKFLOW_VIEW`/`WORKFLOW_MANAGE` × perfis padrão; MFA exigido; IDs de outro tenant → 404/422.
- **Concorrência:** duas edições com mesmo `If-Match` (412); edição × publicação serializadas.
- **E2E:** coberto pela US-043.
- **Acessibilidade/performance:** validador p95 < 200 ms para 50 etapas/200 transições/200 regras (benchmark Vitest).

## Definition of Done
- [ ] Cenários Gherkin automatizados (API + integração) e passando no CI
- [ ] Validador com todos os códigos `WF_*` documentados e testados (inclusive property-based)
- [ ] Triggers de imutabilidade comprovados por teste com SQL direto
- [ ] Snapshot canônico + `definitionHash` reprodutível verificado
- [ ] `WorkflowVersionPublisher` exportado na fachada e usado pelo seeder da US-042
- [ ] Auditoria e eventos verificados; teste na suíte "tenant leak"
- [ ] OpenAPI de WF-02..04 e WF-07..18 compatível com api.md
- [ ] Logs sem expressões/conteúdo; métricas de validação e publicação
- [ ] Revisão de código e de segurança aprovadas (whitelist JSON Logic revisada)

## Estimativa
**L** — modelo com 5 tabelas, FKs compostas circulares, triggers de imutabilidade, 15 endpoints de manutenção, validador de grafo com ~17 regras, canonicalização/hash e clonagem com remapeamento, além de testes property-based.

## Prioridade
**P0** — sem o modelo e o publicador não há workflow semeado (US-042), motor (US-041), criação de processo (US-001) nem tramitação (EP-008).
