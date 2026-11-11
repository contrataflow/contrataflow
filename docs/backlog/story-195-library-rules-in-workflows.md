---
id: US-195
title: "Usar regras da biblioteca nos workflows por versão fixada"
epic: EP-031
feature: FT-088
mvp: 2
priority: P1
estimate: M
status: Especificada
depends_on: [US-045, US-194]
modules: [workflow, rules, process, access, audit]
screens: [SCR-034, SCR-035]
endpoints: [WF-16, WF-17, WF-19, WF-20, WF-21, WF-80, WF-81, RUL-01, RUL-11]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW]
events: [WorkflowVersionPublished]
---

# US-195 — Usar regras da biblioteca nos workflows por versão fixada

## Título
Usar regras da biblioteca nos workflows por versão fixada

## Descrição
**Como** administrador do órgão, **quero** escolher uma regra da biblioteca ao configurar a saída de uma etapa ou uma transição do workflow, fixar nela uma versão publicada e ver em quais workflows cada versão é usada, **para** reaproveitar a mesma regra em vários workflows e adotar uma correção só quando eu decidir, sem alterar workflows já publicados nem processos em andamento.

A story liga a biblioteca (US-194) ao motor de workflow: a `WorkflowRule` ganha `ruleDefinitionVersionId` (versão fixada) e `contextVersion`; a publicação da versão do workflow valida cada referência, grava `WorkflowVersion.ruleRefs` na mesma transação e inclui as versões no hash da definição; o editor (SCR-034, aba "Regras") ganha o seletor "Usar regra da biblioteca"; a aba "Usos" da SCR-035 lista, por regra e por versão, os workflows que a usam e os candidatos à adoção de uma versão mais nova. As regras do MVP 1 (locais, `INLINE`, contexto v1) seguem funcionando sem migração.

## Contexto
- A DEC-204 e a ADR-015 determinam que o workflow referencia a regra da biblioteca por **versão fixada**, "mesma lógica da DEC-014": editar a regra cria nova versão e não altera workflows publicados. `WorkflowRule` continua existindo para regras locais e para as do MVP 1 (entities.md §5.8: `ruleDefinitionVersionId` nulo = regra local; quando presente, `config` é ignorado e vale a expressão da biblioteca; check `rule_definition_version_id IS NULL OR type = 'CONDITION'`).
- `RuleRef` (entities.md §7.1) tem dois modos: `INLINE` (expressão local) e `LIBRARY` (`ruleDefinitionId` + `ruleDefinitionVersionId`). Na publicação do workflow, `LIBRARY` exige versão `PUBLISHED` cujo `kind` combine com o uso. Esta story entrega a validação e o uso em **regras de saída** (`WorkflowRule`); a mesma matriz de tipos vale para os usos de roteamento e alçada das US-197 e US-198, que reusam o validador daqui.
- Publicar versão nova da regra aposenta a anterior (US-194, RN-RULE-11): os workflows já publicados continuam na versão fixada (ela vira `RETIRED`, mas continua avaliável), e a tela de usos os mostra como candidatos à adoção (feature FT-088, cenário "Publicar uma regra e usá-la em dois workflows").
- O motor de workflow (US-041) avalia `WorkflowRule` sobre o `RuleContext` v1; com a biblioteca ele passa a montar o contexto da `contextVersion` de cada regra (v1 ou v2, US-129), de forma preguiçosa por namespace (ADR-015).
- Regras do MVP 1 (`REQUIRED_DOCUMENT`, `REQUIRED_FIELD`, `REQUIRED_APPROVAL`, `CONDITION` locais) não migram à força: passam à biblioteca por escolha do administrador (DEC-204, roadmap §4.10: "nada é imposto").

## Objetivo
Permitir que o administrador use uma regra da biblioteca num workflow em até 3 minutos, com 100% das referências validadas na publicação, `ruleRefs` gravado em toda versão publicada que usa a biblioteca e zero alteração de comportamento em workflows e processos existentes quando uma nova versão da regra é publicada.

## Persona
- **Principal:** Administrador do órgão (`ADMIN_ORGAO`, com `WORKFLOW_MANAGE`, `WORKFLOW_PUBLISH` e `RULE_VIEW`).
- **Secundárias:** Controle interno (`CONTROLE_INTERNO`) e Auditor (`AUDITOR`), que leem a aba "Usos" e o `ruleRefs` das versões para rastrear qual versão de regra valia num workflow; Gestor de contratações (`GESTOR_CONTRATACOES`), que vê as regras aplicadas ao processo.

## Pré-condições
- Existe uma `WorkflowVersion` em `DRAFT` com a etapa ou a transição alvo (US-043) e uma regra da biblioteca ativa, não-modelo, com versão `PUBLISHED` e `kind` compatível com o uso (US-194).
- O usuário tem `WORKFLOW_MANAGE` para editar o workflow e `RULE_VIEW` para escolher regras da biblioteca; `WORKFLOW_PUBLISH` para publicar a versão do workflow.
- US-129 entregue (contexto v2) quando a regra escolhida tiver `contextVersion = 2`.

## Fluxo principal
1. No editor do workflow (SCR-034), aba "Regras", o administrador escolhe uma saída de etapa ou uma transição e clica em "Nova regra" → "Usar regra da biblioteca".
2. O sistema chama RUL-01 com `kind = VALIDATION`, `isActive = true`, `hasPublishedVersion = true` e `isSystem = false` e mostra as regras: nome, descrição, etiquetas, versão vigente e `contextVersion`.
3. O administrador escolhe a regra; o seletor propõe a **versão vigente** (e permite escolher outra versão `PUBLISHED`). Ele confirma nome de exibição (padrão: nome da regra), `isActive` e ordem.
4. O front envia WF-16 com `type = CONDITION`, `scope`, `stageId` ou `transitionId` e `ruleDefinitionVersionId`. A API valida tenant, estado `PUBLISHED`, `kind = VALIDATION`, regra ativa e unicidade no âmbito; copia `severity`, `message` e `contextVersion` da versão para a `WorkflowRule`, ignora `config` e responde 201 com `ruleSource`. Audita `workflow.update`.
5. A lista mostra a regra com o selo "Biblioteca · COBERTURA_DO_ORGAO v1" e o link "Abrir na biblioteca"; expressão, severidade e mensagem ficam somente leitura.
6. O administrador valida a versão do workflow (WF-20): o validador confere cada referência `LIBRARY` e devolve `errors[]` e `warnings[]` (`WF_RULE_REF_INVALID`, `WF_RULE_REF_INACTIVE`).
7. Ao publicar (WF-21), a API revalida dentro da transação, monta `ruleRefs` com cada versão fixada (`ruleDefinitionVersionId`, `versionNumber`, `expressionHash`, `contextVersion`, onde é usada), inclui as versões no `definitionSnapshot` e no `definitionHash`, audita `workflow.version_publish` e grava `WorkflowVersionPublished`.
8. Mais tarde a regra recebe a versão 2 (US-194). Os workflows publicados continuam na versão 1; a aba "Usos" da regra (RUL-11) lista os workflows e as versões do workflow que a usam, com o selo "Candidato à adoção da v2".
9. Para adotar, o administrador cria o rascunho do workflow (WF-08) e usa "Adotar versão vigente" (WF-81), que troca a versão fixada em todos os usos daquela regra no rascunho; depois valida e publica uma nova versão do workflow. Processos em andamento continuam na versão do workflow em que estão (DEC-014).

## Fluxos alternativos
- **FA-01 — Regra local continua:** "Nova regra local" mantém o fluxo do MVP 1 (US-044): `INLINE`, `contextVersion` 1 por padrão; WF-16 sem `ruleDefinitionVersionId` não muda.
- **FA-02 — Tipo incompatível:** escolher uma regra `ROUTING`, `APPROVAL_THRESHOLD`, `SLA` ou `NOTIFICATION` como regra de saída é recusado (`RULE_KIND_MISMATCH`); o seletor nem as lista, mas a API valida.
- **FA-03 — Versão já aposentada no rascunho:** se a versão fixada num rascunho foi aposentada (a regra recebeu versão nova), WF-20 aponta `WF_RULE_REF_INVALID` (`RETIRED`) e a tela oferece "Adotar versão vigente" por regra ou "Adotar todas" (D-01 em Lacunas).
- **FA-04 — Regra inativada depois do uso:** o uso no rascunho gera apenas aviso `WF_RULE_REF_INACTIVE`; usos publicados não mudam. Escolher uma regra inativa para novo uso é recusado (`RULE_INACTIVE`).
- **FA-05 — Trocar a versão fixada manualmente:** WF-17 aceita trocar `ruleDefinitionVersionId` por outra versão `PUBLISHED` da mesma regra (ex.: voltar à v1 `RETIRED` é recusado; escolher a vigente é aceito).
- **FA-06 — Substituir regra local pela da biblioteca:** o administrador cria o uso da biblioteca e exclui a regra local (WF-18); não há conversão automática (dados do MVP 1 intactos).
- **FA-07 — Mesma regra em dois âmbitos:** permitido (etapas ou transições diferentes); o mesmo âmbito não aceita a mesma regra duas vezes (`CONFLICT`).
- **FA-08 — Versão do workflow publicada:** qualquer escrita de uso ou adoção sobre versão não `DRAFT` responde `WORKFLOW_VERSION_NOT_DRAFT` (409), como em WF-16.
- **FA-09 — Consulta sem edição:** Controle interno e Auditor (`RULE_VIEW`) abrem "Usos" e o diff entre as versões fixadas de duas versões do workflow; não têm botões de edição.

## Regras de negócio
- **RN-RULE-26** — Uma `WorkflowRule` pode referenciar uma versão da biblioteca (`ruleDefinitionVersionId`): só com `type = CONDITION` e `scope` `STAGE_EXIT` ou `TRANSITION`; `config` é ignorado; a regra local (campo nulo) segue o MVP 1 sem alteração (entities.md §5.8, RN-WF-53).
- **RN-RULE-27** — A versão é **fixada na escolha**: precisa existir no tenant, estar `PUBLISHED`, pertencer a regra ativa e não-modelo (`isSystem = false`) e ter `kind` compatível com o uso; a API recusa versão `DRAFT`, `RETIRED` ou de outro tenant (DEC-204, entities.md §7.1).
- **RN-RULE-28** — **Matriz de uso por tipo**, validada na API e na publicação (catálogo `RuleUsageCatalog`): `WorkflowRule` (saída de etapa e transição) → `VALIDATION`; `WorkflowStage.applicabilityRule` e `WorkflowTransition.condition` → `ROUTING` (US-197); `WorkflowStage.decisionPolicyRules[].when` e `WorkflowStageApprover.applicabilityRule` → `APPROVAL_THRESHOLD` (US-198); `SlaPolicy` → `SLA` e `NotificationRule` → `NOTIFICATION` (EP-030). Uso fora da matriz: `RULE_KIND_MISMATCH` (422).
- **RN-RULE-29** — Ao usar a biblioteca, a `WorkflowRule` copia `contextVersion`, `severity` e `message` da versão fixada e nunca os sobrescreve localmente: a regra reutilizada é idêntica em todos os workflows; para mudar o texto, nova versão da regra (US-194).
- **RN-RULE-30** — Na publicação do workflow (WF-21) a API grava `WorkflowVersion.ruleRefs` na **mesma transação** com um item por versão fixada — `{ ruleDefinitionId, key, kind, ruleDefinitionVersionId, versionNumber, expressionHash, contextVersion, usedIn[] }` — e o inclui no `definitionSnapshot` e no `definitionHash` (RN-WF-64); a versão publicada do workflow continua imutável (RN-WF-65).
- **RN-RULE-31** — Na validação (WF-20) e na publicação (WF-21), cada referência `LIBRARY` do workflow (regras de saída e os usos das US-197/US-198) é conferida: `NOT_FOUND`, `NOT_PUBLISHED` (inclusive `RETIRED`), `KIND_MISMATCH` são **erros** `WF_RULE_REF_INVALID`; regra inativa é **aviso** `WF_RULE_REF_INACTIVE`. Erros bloqueiam a publicação (RN-WF-61).
- **RN-RULE-32** — Publicar versão nova de uma regra **não altera** nenhum workflow publicado nem processo em andamento; as versões fixadas (inclusive `RETIRED`) continuam avaliáveis (DEC-204, ADR-015). A adoção da versão nova é sempre por escolha do administrador.
- **RN-RULE-33** — Adotar (WF-81) só opera sobre `WorkflowVersion` em `DRAFT`, para uma versão `PUBLISHED` da **mesma** `RuleDefinition` (por padrão a vigente), troca a versão fixada em **todos** os usos daquela regra no rascunho em uma transação, copia `severity`/`message`/`contextVersion` da nova versão e responde com os usos alterados; reaplicar a mesma adoção é idempotente (`changed = 0`).
- **RN-RULE-34** — A aba "Usos" (RUL-11) lista, por versão da regra, os workflows e as versões de workflow que a usam: versões publicadas pelo `ruleRefs`; rascunhos pelos usos correntes. Um uso é **candidato à adoção** quando a versão de workflow é a vigente ou o rascunho de um workflow ativo e a versão de regra fixada não é a vigente da regra.
- **RN-RULE-35** — O seletor usa RUL-01 com `isActive = true`, `hasPublishedVersion = true`, `isSystem = false` e o `kind` do uso; regra inativa, sem versão vigente ou modelo do sistema não é oferecida a novos usos, mas usos publicados continuam (RN-RULE-14, RN-RULE-15).
- **RN-RULE-36** — Em execução, o motor avalia a regra da biblioteca com a expressão da **versão fixada** sobre o contexto da `contextVersion` dela; contextos v1 e v2 podem coexistir na mesma avaliação (um por versão, montados de forma preguiçosa e cacheados por requisição). Verdadeiro = satisfeita; `severity` e `message` vêm da `WorkflowRule`; avisos seguem o reconhecimento do MVP 1 (DEC-016).
- **RN-RULE-37** — Regras do MVP 1 (locais e as de outros tipos) continuam avaliadas com o contexto v1 e nada quebra; novas regras `INLINE` aceitam `contextVersion` 1 ou 2 (padrão 1), nunca misturando caminhos de versões diferentes (teste de regressão obrigatório, DoD do épico).
- **RN-RULE-38** — Erro ao avaliar uma regra da biblioteca (caminho que sumiu do contexto, contribuidor indisponível) nunca libera a saída em silêncio: regra `BLOCKING` fica não satisfeita com `EVALUATION_FAILED` e mensagem da regra; indisponibilidade do banco ou de provedor de contexto resulta em 503 e nada muda (sem efeito parcial).
- **RN-RULE-39** — A mesma versão de regra não pode ser usada duas vezes no mesmo âmbito (`stageId` ou `transitionId`) da mesma versão de workflow (unique parcial); a regra pode ser usada em vários âmbitos e workflows.
- **RN-RULE-40** — Toda escrita é auditada (`workflow.update` com `metadata.ruleDefinitionVersionId`; `workflow.version_publish` com `ruleRefsCount`) e isolada por tenant: ids de versão de regra de outro tenant respondem como referência inexistente (422 `REFERENCE_NOT_FOUND`), sem revelar existência.
- **RN-RULE-41** — A fonte do KPI "regras usadas em mais de um workflow" (≥ 30% das regras ativas) é `WorkflowVersion.ruleRefs` das versões vigentes; o campo é indexado para consulta por `ruleDefinitionVersionId`.
- **RN-RULE-42** — O editor nunca copia a expressão para dentro do workflow: o `definitionSnapshot` guarda a referência e o `expressionHash`; auditores comparam o hash para provar qual expressão valia (a versão da regra é imutável, RN-RULE-04).

Regras do MVP 1 que se aplicam, sem renumerar: **RN-WF-53/54** (âmbito da regra e só em `DRAFT`), **RN-WF-58** (executor com *allowlist*), **RN-WF-61** (erros bloqueiam a publicação), **RN-WF-64/65** (snapshot, hash e imutabilidade), **RN-WF-67** (processos continuam na versão fixada do workflow).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Regra da biblioteca | `ruleDefinitionVersionId` | uuid | Condicional (uso da biblioteca) | versão `PUBLISHED`, regra ativa e não-modelo, `kind` compatível, mesmo tenant | versão vigente da regra escolhida |
| Tipo da regra | `type` | `RuleType` | Sim | `CONDITION` quando há `ruleDefinitionVersionId` | `CONDITION` |
| Âmbito | `scope`, `stageId`, `transitionId` | como WF-16 | Sim | RN-WF-53; mesma versão do workflow | — |
| Nome de exibição | `name` | texto | Sim | até 150 caracteres | nome da regra |
| Ativa | `isActive` | interruptor | Não | — | `true` |
| Ordem | `displayOrder` | inteiro ≥ 0 | Não | — | ordem de criação |
| *(sistema)* Severidade | `severity` | `RuleSeverity` | — | copiada da versão; não editável no uso | da versão |
| *(sistema)* Mensagem | `message` | texto | — | copiada da versão; não editável no uso | da versão |
| *(sistema)* Versão do contexto | `contextVersion` | 1 ou 2 | — | copiada da versão; `INLINE` aceita 1 ou 2 | da versão (biblioteca) / 1 (local) |
| *(sistema)* Origem da regra | `ruleSource` | objeto | — | `{ mode, ruleDefinitionId, key, name, versionNumber, versionStatus, contextVersion }` | calculado |
| Regra a adotar | `ruleDefinitionId` | uuid | Sim (WF-81) | regra usada no rascunho | — |
| Versão de destino | `toRuleDefinitionVersionId` | uuid | Não (WF-81) | `PUBLISHED`, mesma regra | vigente |
| *(sistema)* Referências fixadas | `WorkflowVersion.ruleRefs` | lista | — | gravada na publicação | `[]` |
| *(filtro)* Versão da regra | `versionId` | uuid | Não (RUL-11) | pertence à regra | todas |
| *(filtro)* Só candidatos | `onlyCandidates` | booleano | Não (RUL-11) | RN-RULE-34 | `false` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `ruleDefinitionVersionId` com `type` diferente de `CONDITION`, ou com `config`, `severity` ou `message` informados | Front + API (Zod) | "Regras da biblioteca não aceitam configuração local. Use a regra como está ou crie uma regra local." | `VALIDATION_ERROR` (`NOT_ALLOWED`) |
| V-02 | Versão inexistente, de outro tenant ou sem `RULE_VIEW` sobre a biblioteca | API | "Selecione uma regra válida da biblioteca." | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) |
| V-03 | Versão que não está `PUBLISHED` | API | "Esta versão da regra não está publicada. Escolha a versão vigente." | `RULE_VERSION_NOT_PUBLISHED` |
| V-04 | `kind` incompatível com o uso | API | "Esta regra é do tipo {tipo} e não pode ser usada aqui." | `RULE_KIND_MISMATCH` |
| V-05 | Regra inativa ou modelo do sistema escolhidos para novo uso | API | "Esta regra está inativa ou é um modelo. Copie o modelo ou reative a regra na biblioteca." | `RULE_INACTIVE` |
| V-06 | Mesma versão de regra já usada no âmbito | API | "Esta regra já está aplicada aqui." | `CONFLICT` |
| V-07 | Escrever em versão de workflow que não está `DRAFT` | API | "Esta versão do workflow não pode mais ser editada." | `WORKFLOW_VERSION_NOT_DRAFT` |
| V-08 | Referência `LIBRARY` inválida na validação/publicação (`NOT_FOUND`, `NOT_PUBLISHED`, `KIND_MISMATCH`) | API | "A regra {nome} usa uma versão que não pode ser publicada: {motivo}." | `WORKFLOW_INVALID` (`WF_RULE_REF_INVALID`) |
| V-09 | Regra inativa já fixada no rascunho | API | "A regra {nome} está inativa. O uso continua, mas revise." | aviso `WF_RULE_REF_INACTIVE` |
| V-10 | Adoção para versão de outra regra ou não publicada | API | "Escolha uma versão publicada da mesma regra." | `RULE_VERSION_NOT_PUBLISHED` / `VALIDATION_ERROR` |
| V-11 | `If-Match` ausente ou divergente (WF-17, WF-81) | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | `name` ou `displayOrder` fora dos limites | Front + API | "O nome deve ter até 150 caracteres." | `VALIDATION_ERROR` (`TOO_LONG`) |

## Permissões
- **Permissão:** `WORKFLOW_MANAGE` para criar, trocar e adotar usos no rascunho (WF-16, WF-17, WF-81) e `RULE_VIEW` para escolher regras da biblioteca; `WORKFLOW_VIEW` para WF-20 e WF-80; `WORKFLOW_PUBLISH` para WF-21; `RULE_VIEW` para RUL-01 e RUL-11. Nenhuma é escopável.
- **Políticas:** POL-27 (a regra de roteamento fora de etapa `isLegallyRequired` é validada pela US-197 sobre o mesmo validador); visibilidade do workflow como no MVP 1. Nenhuma política contextual nova.
- **MFA:** WF-21 segue o MVP 1 (`WORKFLOW_PUBLISH` é `HIGH`; `security.mfaPolicy` conforme POL-14). WF-16, WF-17 e WF-81 não exigem MFA própria.
- **Sem permissão:** "Usar regra da biblioteca" fica oculto sem `RULE_VIEW`; edição oculta sem `WORKFLOW_MANAGE`; a API responde 403 `PERMISSION_DENIED` (com `reasonCode` da permissão faltante) e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowVersionPublished` (MVP 1) | `workflow.version_published` | Commit de WF-21 | Payload do MVP 1 (`workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash`) com acréscimo opcional `ruleRefsCount` (aditivo, DEC-108, ver Lacunas L-02); `ruleRefs` já está gravado na transação, não por consumidor |

Usar, trocar ou adotar regra no rascunho do workflow não gera evento de domínio (edição em rascunho, padrão WF-10 a WF-18): apenas auditoria.

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. A adoção de versão é decisão do administrador; a aba "Usos" mostra os candidatos, sem aviso ativo (notificar quem mantém workflows quando sai versão nova de regra fica fora do escopo). |

## Critérios de aceite em Gherkin
```gherkin
Feature: Usar regras da biblioteca nos workflows por versão fixada

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And "Marina" tem vínculo ativo com o perfil "ADMIN_ORGAO" (WORKFLOW_MANAGE, WORKFLOW_PUBLISH, RULE_VIEW)
    And a regra "COBERTURA_DO_ORGAO" (tipo "VALIDATION", expressão "budget.coverageRatio >= 1") tem a versão 1 "PUBLISHED"
    And existem os workflows "Fase preparatória" e "Contratação direta" com versões em rascunho e a etapa "DOTACAO"

  Scenario: [Sucesso] Usar a regra na saída da etapa DOTACAO
    When "Marina" criar em "Fase preparatória" uma regra de saída da etapa "DOTACAO" com a versão 1 de "COBERTURA_DO_ORGAO"
    Then a API deve responder 201 com "ruleSource" mostrando "COBERTURA_DO_ORGAO" na versão 1 e "contextVersion" 2
    And a regra deve copiar a severidade e a mensagem da versão 1 e ignorar "config"
    And deve gerar registro de auditoria "workflow.update" com "metadata.ruleDefinitionVersionId"
    And não deve gerar evento de domínio

  Scenario: [Sucesso] Publicar os dois workflows fixa as versões em ruleRefs
    Given que "Fase preparatória" e "Contratação direta" usam a versão 1 de "COBERTURA_DO_ORGAO" em "DOTACAO"
    When "Marina" publicar as duas versões de workflow
    Then cada versão deve registrar em "ruleRefs" a "COBERTURA_DO_ORGAO" versão 1 com o "expressionHash" e a etapa "DOTACAO" em "usedIn"
    And o "definitionHash" de cada versão deve incluir a referência
    And deve gerar registro de auditoria "workflow.version_publish" com "ruleRefsCount" igual a 1
    And deve gerar o evento "WorkflowVersionPublished" para cada workflow

  Scenario: [Sucesso] Versão nova da regra não altera os workflows publicados
    Given que os dois workflows publicados usam a versão 1 e "COBERTURA_DO_ORGAO" ganhou a versão 2 (">= 0.95")
    When "Marina" consultar os usos da regra
    Then a versão 1 deve estar "RETIRED" e os dois workflows devem aparecer como "adoptionCandidate" da versão 2
    And um processo "0021/2026" em "Fase preparatória" com "budget.coverageRatio" igual a 0,96 deve continuar bloqueado na saída de "DOTACAO" pela versão 1

  Scenario: [Sucesso] Adotar a versão 2 em um rascunho e publicar
    Given que "Marina" criou o rascunho de "Fase preparatória" a partir da versão publicada
    When "Marina" adotar a versão vigente da regra "COBERTURA_DO_ORGAO" no rascunho
    Then a API deve responder 200 com "changed" igual a 1 e a regra de "DOTACAO" apontando para a versão 2
    And deve gerar registro de auditoria "workflow.update" com "metadata.action" igual a "RULE_REF_ADOPT"
    When "Marina" publicar o rascunho com "changeNotes"
    Then "ruleRefs" deve registrar a versão 2 e deve gerar o evento "WorkflowVersionPublished"
    And "Contratação direta" deve continuar na versão 1

  Scenario: [Sucesso] Regra do MVP 1 continua com o contexto v1
    Given que "Fase preparatória" tem uma regra local "REQUIRED_DOCUMENT" (ETP) com "contextVersion" 1
    When um processo tentar sair da etapa sem o ETP
    Then a regra deve ser avaliada com o contexto v1 e bloquear a saída como antes
    And a regra da biblioteca na mesma etapa deve ser avaliada com o contexto v2

  Scenario: [Validação] Tipo, estado e unicidade da regra escolhida
    Given que a regra "CI_ACIMA_DE_VALOR" é do tipo "ROUTING" e a versão 2 de "COBERTURA_DO_ORGAO" está em "DRAFT"
    When "Marina" usar "CI_ACIMA_DE_VALOR" como regra de saída
    Then a API deve responder 422 com código "RULE_KIND_MISMATCH"
    When "Marina" usar a versão 2 em rascunho de "COBERTURA_DO_ORGAO"
    Then a API deve responder 422 com código "RULE_VERSION_NOT_PUBLISHED"
    When "Marina" enviar "ruleDefinitionVersionId" junto de "config"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "NOT_ALLOWED"

  Scenario: [Validação] Publicar workflow com versão de regra aposentada
    Given que o rascunho de "Contratação direta" fixa a versão 1 de "COBERTURA_DO_ORGAO", já "RETIRED"
    When "Marina" publicar o rascunho
    Then a API deve responder 422 com código "WORKFLOW_INVALID" e erro "WF_RULE_REF_INVALID" com motivo "NOT_PUBLISHED"
    And a versão do workflow deve continuar "DRAFT"

  Scenario: [Permissão] Sem permissão sobre a biblioteca ou sobre o workflow
    Given que "Sandra" tem "WORKFLOW_MANAGE" mas não tem "RULE_VIEW"
    When "Sandra" usar uma regra da biblioteca em "DOTACAO"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e "reasonCode" igual a "RULE_VIEW"
    And deve gerar registro de auditoria "access.denied"
    Given que "Bruno" tem o perfil "PLANEJAMENTO" sem "WORKFLOW_MANAGE"
    When "Bruno" adotar uma versão de regra em um rascunho
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Versão de regra de outro tenant
    Given que a regra "CI_ACIMA_DE_VALOR" com a versão publicada "V9" pertence ao tenant "Prefeitura B"
    When "Marina", no tenant "Prefeitura A", usar a versão "V9" na saída de "DOTACAO"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "REFERENCE_NOT_FOUND"
    When "Marina" consultar os usos da regra do tenant "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser revelado

  Scenario: [Duplicidade] Mesma regra no mesmo âmbito e adoção repetida
    Given que a saída de "DOTACAO" já usa a versão 1 de "COBERTURA_DO_ORGAO"
    When "Marina" usar novamente a mesma versão nessa saída
    Then a API deve responder 409 com código "CONFLICT"
    Given que "Marina" adotou a versão 2 no rascunho
    When "Marina" repetir a adoção com a mesma requisição
    Then a API deve responder 200 com "changed" igual a 0
    And não deve haver nova auditoria "workflow.update" para a adoção

  Scenario: [Concorrência] Adoção simultânea e publicação da regra durante a escolha
    Given que "Marina" e outro administrador carregaram o rascunho de "Fase preparatória" com o mesmo "If-Match"
    When os dois adotarem a versão vigente ao mesmo tempo
    Then uma requisição deve responder 200 e a outra 412 com código "VERSION_CONFLICT"
    Given que "Marina" escolheu a versão 1 no seletor e, antes de salvar, outro administrador publicou a versão 2
    When "Marina" salvar o uso da versão 1
    Then a API deve responder 422 com código "RULE_VERSION_NOT_PUBLISHED" e a tela deve oferecer a versão 2

  Scenario: [Falha de banco] Banco indisponível na publicação do workflow
    Given que o banco de dados fica indisponível durante a transação de publicação
    When "Marina" publicar "Fase preparatória"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão deve continuar "DRAFT", sem "ruleRefs", sem auditoria e sem evento

  Scenario: [Falha de integração] Relay do outbox e cache de expressões indisponíveis
    Given que o relay do outbox está indisponível
    When "Marina" publicar "Contratação direta" com sucesso
    Then a API deve responder 200
    And o evento "WorkflowVersionPublished" deve permanecer "PENDING" no outbox até o relay voltar
    Given que o Redis está indisponível
    When um processo de "Contratação direta" avaliar a regra da biblioteca
    Then a expressão da versão fixada deve ser lida do banco e a avaliação deve seguir normalmente
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Combinação de campos inválida | 422 | `VALIDATION_ERROR` | "Regras da biblioteca não aceitam configuração local." | Marca o campo; mantém o painel |
| Versão inexistente ou de outro tenant | 422 | `VALIDATION_ERROR` (`REFERENCE_NOT_FOUND`) | "Selecione uma regra válida da biblioteca." | Recarrega o seletor |
| Versão não publicada | 422 | `RULE_VERSION_NOT_PUBLISHED` | "Esta versão da regra não está publicada. Escolha a versão vigente." | Seleciona a vigente |
| Tipo incompatível | 422 | `RULE_KIND_MISMATCH` | "Esta regra é do tipo {tipo} e não pode ser usada aqui." | Filtra o seletor |
| Regra inativa ou modelo | 422 | `RULE_INACTIVE` | "Esta regra está inativa ou é um modelo. Copie o modelo ou reative a regra na biblioteca." | Link para a biblioteca |
| Regra já aplicada no âmbito | 409 | `CONFLICT` | "Esta regra já está aplicada aqui." | Foca a regra existente |
| Versão do workflow não é rascunho | 409 | `WORKFLOW_VERSION_NOT_DRAFT` | "Esta versão do workflow não pode mais ser editada." | Oferece "Criar novo rascunho" |
| Referência inválida na publicação | 422 | `WORKFLOW_INVALID` (`WF_RULE_REF_INVALID`) | "A regra {nome} usa uma versão que não pode ser publicada: {motivo}." | Lista erros com "Adotar versão vigente" |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para esta ação." | Oculta ações |
| Workflow, versão ou regra inexistente / outro tenant | 404 | `NOT_FOUND` | "Registro não encontrado." | Volta à lista |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Os dados foram alterados. Recarregue e tente novamente." | Recarrega o rascunho |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega |
| Banco ou provedor de contexto indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém a tela; botão "Tentar novamente" |

## Dependências
- **Stories:** US-045 (publicação e versionamento do workflow: WF-20/WF-21, `definitionSnapshot`, `definitionHash`); US-194 (biblioteca, versões e RUL-01). Relacionadas: US-044 (regras locais), US-041 (motor `evaluateRules`), US-043 (editor), US-129 (contexto v2). Habilita US-197 e US-198 (mesma validação de referência e matriz de tipos).
- **Decisões/ADRs:** DEC-204, DEC-014, DEC-016, DEC-108, DEC-196, ADR-015, ADR-008, ADR-005.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:**
  1. **L-01 — Forma de `WorkflowVersion.ruleRefs`:** entities.md §5.7 diz apenas "lista das `RuleDefinitionVersion` fixadas"; aqui se propõe `{ ruleDefinitionId, key, kind, ruleDefinitionVersionId, versionNumber, expressionHash, contextVersion, usedIn[] }` com `usedIn` = `{ useType, stageKey?, transitionKey?, ruleId? }`. Confirmar e registrar no `entities.md`.
  2. **L-02 — Evento:** o card do épico diz que `WorkflowVersionPublished` é "consumido" para fixar `ruleRefs`; aqui o `ruleRefs` é gravado **na transação da publicação** (um consumidor deixaria janela sem referência e o hash não o cobriria). Falta `ruleRefsCount` aditivo no payload (events.md §2).
  3. **L-03 — Códigos de erro novos** (`RULE_KIND_MISMATCH`, `RULE_VERSION_NOT_PUBLISHED`, `RULE_INACTIVE`, `WF_RULE_REF_INVALID`, aviso `WF_RULE_REF_INACTIVE`): a consolidar no catálogo `WF_*` do api.md.
  4. **L-04 — Ação de auditoria da adoção:** não há `rule.*` nem `workflow.*` própria; usa-se `workflow.update` com `metadata.action = RULE_REF_ADOPT`.
  5. **D-01 (dúvida de produto) — Versão aposentada herdada:** entities.md §7.1 exige versão `PUBLISHED` na publicação. Como publicar versão nova de regra aposenta a anterior, **todo rascunho copiado de um workflow publicado que a usa fica impedido de publicar** até adotar a versão vigente, mesmo para uma mudança sem relação. Alternativa a decidir com o produto: aceitar `RETIRED` quando a mesma versão já estava fixada na versão publicada anterior do workflow (com aviso). Este card segue a regra estrita das fontes.
  6. **L-05 — Índice por `ruleRefs`:** a consulta de usos por `ruleDefinitionVersionId` pede índice GIN em `workflow_versions.rule_refs`, ainda fora de entities.md §10.

## Impacto técnico
- **Compatibilidade:** campos aditivos (DEC-108); WF-16/WF-17 sem `ruleDefinitionVersionId` e WF-19 sem `version` mantêm o comportamento do MVP 1; `WorkflowRule.contextVersion` tem padrão 1.
- **Hash e imutabilidade:** o `definitionSnapshot` passa a incluir `ruleRefs` com `expressionHash`; como a versão de regra é imutável (trigger, US-194), basta a referência para reproduzir o comportamento; versões de workflow anteriores à biblioteca mantêm o hash antigo (campo ausente = lista vazia).
- **Avaliação:** o `RuleEvaluator` ganha a estratégia "versão fixada da biblioteca" e um *resolver* de expressão com cache por requisição (e Redis opcional com *fallback* ao banco); contextos v1 e v2 são montados sob demanda, com o custo limitado por namespace referenciado (ADR-015).
- **Concorrência:** WF-81 e WF-17 competem pelo mesmo rascunho; ambos usam `If-Match` do `WorkflowVersion`.
- **Migração:** colunas `rule_definition_version_id` e `context_version` de `workflow_rules` e `rule_refs` de `workflow_versions` entram na M2-04; sem backfill (regras existentes ficam locais).
- **Processos em andamento:** nenhum efeito (DEC-014); a migração para versão nova de workflow é do EP-021 e não é automática.

## Backend
- **Módulo(s):** `workflow` (dono do uso, validação e `ruleRefs`), `rules` (consulta de versões e catálogo de uso por tipo), `process` (avaliação em execução via `WorkflowFacade`), `access`, `audit`, `platform` (`OutboxWriter`).
- **Casos de uso:** `AttachLibraryRuleCommand` (WF-16), `ChangeLibraryRuleVersionCommand` (WF-17), `AdoptRuleVersionCommand` (WF-81), `ListWorkflowRuleRefsQuery` (WF-80), `ListRuleUsagesQuery` (RUL-11); extensões de `ValidateWorkflowVersionQuery` (WF-20) e `WorkflowVersionPublisher` (WF-21).
- **Domínio:** `RuleUsageCatalog` (matriz de tipos por ponto de uso, RN-RULE-28), `RuleRefValidator` (compartilhado com US-197/US-198), `RuleRefsAssembler` (monta `ruleRefs`), `LibraryRuleEvaluator` (estratégia do `RuleEvaluator`).
- **Integrações internas:** `RulesFacade.getPublishedVersion(id)` e `RulesFacade.getVersions(ids)` (leitura imutável); `RuleContextBuilder` por `contextVersion` (US-129); `AuthorizationService`.
- **Transação:** WF-16/17/81 gravam sob `FOR UPDATE` da `WorkflowVersion` com conferência de `If-Match` e de estado `DRAFT`; WF-21 valida, monta `ruleRefs`, calcula o hash, publica, aposenta a anterior, audita e grava o outbox atomicamente.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`, aba "Regras", seletor e lista com selo de biblioteca) e SCR-035 (`/admin/regras/[ruleId]`, aba "Usos").
- **Componentes:** `LibraryRulePicker` (busca, filtros de etiqueta, versão vigente e `contextVersion`), `LibraryRuleBadge` ("Biblioteca · {chave} v{n}", com estado da versão: vigente ou aposentada), `AdoptVersionDialog` (resumo dos usos que mudam), `WorkflowRuleRefsPanel` (WF-80, com erros de validação por referência), `RuleUsagesTable` (RUL-11 por versão, filtro "só candidatos", ação "Criar rascunho e adotar").
- **Estados:** carregando (skeleton), vazio ("Nenhuma regra da biblioteca disponível para este uso"; "Esta regra ainda não é usada em nenhum workflow"), erro ("Tentar novamente"), sem permissão, conflito (recarrega), versão do workflow publicada (somente leitura).
- **Acessibilidade e responsividade:** seletor navegável por teclado com `aria-live` nos resultados; estado da versão (vigente ou aposentada) por texto e ícone, nunca só cor; tabelas em coluna única abaixo de 768 px; contraste 4,5:1.

## Banco de dados
- **Tabelas:** `workflow_rules` (`rule_definition_version_id`, `context_version`), `workflow_versions` (`rule_refs`), leitura de `rule_definition_versions` e `rule_definitions`; `audit_logs`, `outbox_events`.
- **Migrações:** parte da M2-04 (entities.md §10), sem backfill; índice GIN `workflow_versions USING gin (rule_refs jsonb_path_ops)` proposto (L-05).
- **Índices/constraints relevantes:** FK composta `workflow_rules (tenant_id, rule_definition_version_id)` → `rule_definition_versions`; check `rule_definition_version_id IS NULL OR type = 'CONDITION'`; unique parcial `(tenant_id, workflow_version_id, stage_id, rule_definition_version_id)` e o equivalente por `transition_id` quando a versão é não nula; trigger de imutabilidade do workflow estendido a `rule_refs`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `WF-16` | POST | `/workflow-versions/{versionId}/rules` | como no MVP 1 + `ruleDefinitionVersionId?` (com `type = CONDITION`, sem `config`/`severity`/`message`) | `201 { data: WorkflowRule }` com `ruleSource` e `contextVersion` | 201, 403, 404, 409, 422, 503 |
| `WF-17` | PATCH | `/workflow-rules/{ruleId}` | como no MVP 1 + troca de `ruleDefinitionVersionId`; `If-Match` | `200 { data: WorkflowRule }` | 200, 403, 409, 412, 422, 428 |
| `WF-19` | GET | `/rule-context/schema` | query `version` (1 ou 2) | campos do contexto da versão pedida (ver US-194) | 200, 403 |
| `WF-20` | POST | `/workflow-versions/{versionId}/validate` | — | `errors[]`/`warnings[]` com `WF_RULE_REF_INVALID` e `WF_RULE_REF_INACTIVE` (campo `details.reason`) | 200, 404 |
| `WF-21` | POST | `/workflow-versions/{versionId}/publish` | `{ changeNotes? }`; `If-Match` | `200 { data: WorkflowVersion }` com `ruleRefs` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `WF-80` | GET | `/workflow-versions/{versionId}/rule-refs` | — | `200 { data: [{ ruleDefinitionId, key, name, kind, ruleDefinitionVersionId, versionNumber, versionStatus, currentVersionId, currentVersionNumber, adoptable, usedIn[] }] }` | 200, 403, 404 |
| `WF-81` | POST | `/workflow-versions/{versionId}/rule-refs/adopt` | `{ ruleDefinitionId, toRuleDefinitionVersionId? }`; `If-Match` | `200 { data: { changed, uses: [{ ruleId, from, to }], validation } }` | 200, 403, 404, 409, 412, 422, 428, 503 |
| `RUL-01` | GET | `/rules` | filtros do seletor (US-194) | lista de regras elegíveis | 200, 403 |
| `RUL-11` | GET | `/rules/{id}/usages` | query `versionId?`, `onlyCandidates?`, `page`, `pageSize` | `200 { data: [{ workflowId, workflowKey, workflowName, workflowVersionId, versionNumber, workflowVersionStatus, ruleDefinitionVersionId, ruleVersionNumber, useType, stageKey?, transitionKey?, adoptionCandidate }], meta, summary: { workflowsCount, byRuleVersion } }` | 200, 403, 404 |

## Logs
- `info` `workflow.library_rule_attached`, `workflow.rule_ref_adopted`, `workflow.rule_refs_fixed` — `workflowVersionId`, `ruleDefinitionId`, `ruleDefinitionVersionId`, contagens, `durationMs`.
- `warn` `workflow.rule_ref_invalid` (motivos e ids, sem expressão), `rule.evaluation_failed` (id da regra, `contextVersion`, caminho ausente, sem valor), `rule_expression.cache_unavailable`.
- `error` `workflow.publish_failed` com causa resumida e `correlationId`.
- **Nunca logar:** a expressão da regra, valores do `RuleContext`, valores de orçamento sigiloso e mensagens de usuário em texto livre.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.update` | `CONFIGURATION` | WF-16, WF-17, WF-18, WF-81 | `metadata`: `ruleId`, `ruleDefinitionVersionId`, `scope`, `stageId`/`transitionId`; na adoção, `action = RULE_REF_ADOPT`, `ruleDefinitionId`, versões de origem e destino, `usesChanged` |
| `workflow.version_publish` | `CONFIGURATION` | WF-21 | acréscimo `ruleRefsCount` e `definitionHash` (MVP 1) |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode` = permissão faltante |

## Testes necessários
- **Unitários:** `RuleUsageCatalog` (matriz de tipos); `RuleRefValidator` (estados, tipo, tenant, inativa); `RuleRefsAssembler` (ordem estável e hash do snapshot); `LibraryRuleEvaluator` (contexto v1 e v2 coexistindo; erro de avaliação em `BLOCKING`); cálculo de `adoptionCandidate`.
- **Integração (Testcontainers PostgreSQL + Redis):** WF-16/WF-17/WF-81 atômicos; WF-21 grava `ruleRefs`, hash, auditoria e outbox; versão aposentada fixada continua avaliando; unique por âmbito; FK composta; *fallback* sem Redis; regressão com regras locais do MVP 1.
- **API/contrato:** WF-16, WF-17, WF-20, WF-21, WF-80, WF-81 e RUL-11 conforme este card; compatibilidade de WF-16 sem os campos novos (regressão do MVP 1).
- **RBAC e multi-tenant:** `WORKFLOW_MANAGE` + `RULE_VIEW` em WF-16; id de versão de outro tenant retorna 422/404 sem vazamento (suíte `test/tenant-leak`); RUL-11 de outro tenant retorna 404.
- **Concorrência:** adoção × edição (If-Match); publicação da versão 2 durante a escolha da versão 1; duas publicações do workflow.
- **E2E (Playwright):** criar regra → publicar → usar em dois workflows → publicar workflows → publicar versão 2 da regra → ver candidatos em "Usos" → adotar em rascunho → publicar → processo avalia a versão nova só no workflow adotado.
- **Acessibilidade/performance:** axe sem violações sérias no seletor e em "Usos"; RUL-11 com 500 usos dentro da meta de leitura; 360 px.

## Definition of Done
- [ ] Critérios de aceite automatizados e passando
- [ ] Permissões e políticas aplicadas na API; UI esconde/desabilita conforme regras
- [ ] Auditoria e eventos verificados em teste
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] OpenAPI atualizado e compatível com api.md
- [ ] Logs sem dados sensíveis; métricas/traces presentes
- [ ] Acessibilidade (axe sem violações sérias) e responsividade verificadas
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada
- [ ] Teste de regressão: regras `WorkflowRule` do MVP 1 continuam avaliadas com o contexto v1
- [ ] `ruleRefs` e `definitionHash` verificados em versão publicada com e sem biblioteca

## Estimativa
**M** — a regra e a versão já existem (US-194); o esforço está na extensão do editor (seletor, selo, adoção), na validação e no `ruleRefs` dentro da publicação existente, na estratégia de avaliação por versão fixada com dois contextos e na tela de usos.

## Prioridade
**P1** — sem o uso por versão fixada a biblioteca é só um cadastro; esta story entrega o ganho central do épico (escrever uma vez, reutilizar, adotar por escolha) e a base de validação de referência de que roteamento e alçadas dependem.
