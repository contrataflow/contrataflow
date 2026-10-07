---
id: US-042
title: "Workflow padrão e seleção por aplicabilidade"
epic: EP-007
feature: FT-029
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-041, US-104]
modules: [workflow, catalog, platform]
screens: [SCR-034]
endpoints: [WF-05, WF-06]
permissions: [WORKFLOW_VIEW, WORKFLOW_PUBLISH]
events: [WorkflowDefaultChanged]
---

# US-042 — Workflow padrão e seleção por aplicabilidade

## Título
Workflow padrão e seleção por aplicabilidade

## Descrição
**Como** administrador do órgão — e, implicitamente, qualquer usuário que crie um processo —, **quero** que o sistema já venha com um workflow padrão completo para a fase preparatória e selecione automaticamente o fluxo correto conforme o tipo de contratação, **para** que nenhum processo fique sem workflow aplicável e contratações diretas sigam um rito mais simples sem configuração manual.

Ao provisionar o tenant (US-099), o sistema semeia dois workflows já publicados: "Fase preparatória — Lei 14.133/2021" (padrão, 7 etapas) e "Contratação direta — Lei 14.133/2021, art. 72" (aplicável quando a modalidade for `DISPENSA`/`INEXIGIBILIDADE`). A resolução de qual workflow se aplica a um processo (`WF-06`) avalia a `applicabilityRule` (JSON Logic) de cada workflow ativo em ordem de `applicabilityPriority`, com o `isDefault` como rede de segurança. Administradores podem trocar qual workflow é o padrão (`WF-05`).

## Contexto
- A fase preparatória "padrão" (art. 18) é distinta do rito de contratação direta (dispensa art. 75 / inexigibilidade art. 74, instruídos conforme art. 72). Sem o sistema, cada órgão decide informalmente quais passos seguir, gerando instrução incompleta.
- DEC-015 define o conteúdo exato dos dois workflows semeados (etapas, SLAs sugeridos, devoluções); DEC-016 rege regras e `applicabilityRule` em JSON Logic; US-041 fornece o motor que avalia essas regras; US-099 executa o provisionamento e invoca o seeder registrado `workflow.seedWorkflows`; US-104 fornece o catálogo `MODALITY` com os códigos `DISPENSA`/`INEXIGIBILIDADE` usados na regra.
- Sem workflow padrão aplicável, a criação do processo (US-001, RN-PROC-06) falha com `NO_APPLICABLE_WORKFLOW`; esta story garante que isso nunca ocorra num tenant novo.

## Objetivo
100% dos tenants provisionados possuem os dois workflows publicados, com exatamente um `isDefault = true`, desde o primeiro minuto; 100% dos processos com modalidade `DISPENSA`/`INEXIGIBILIDADE` resolvem para o workflow de contratação direta e os demais para o padrão, sem intervenção manual.

## Persona
- **Principal:** Administrador do órgão (perfil com `WORKFLOW_PUBLISH`), ao revisar/trocar o padrão.
- **Secundárias:** qualquer usuário que crie um processo (consumidor indireto via `WF-06`); sistema de provisionamento (ator `SYSTEM`) que executa o seeder.

## Pré-condições
- Tenant em provisionamento (`TenantStatus.PROVISIONING`), no passo de seeders do checklist de US-099.
- Catálogo `MODALITY` semeado com os itens ativos `DISPENSA`/`INEXIGIBILIDADE` (US-104).
- Usuário com `WORKFLOW_PUBLISH` para trocar o padrão.

## Fluxo principal
1. No passo de seeders do provisionamento (US-099), o seeder registrado `workflow.seedWorkflows` cria o `Workflow` "Fase preparatória — Lei 14.133/2021" (`key = DEFAULT_PREPARATORY`, `isDefault = true`, `applicabilityPriority = 100`, sem `applicabilityRule`) com sua `WorkflowVersion` 1 já `PUBLISHED`, 7 etapas, transições, SLAs sugeridos e `instructions` pt-BR (DEC-015).
2. O mesmo seeder cria o `Workflow` "Contratação direta — Lei 14.133/2021, art. 72" (`key = DIRECT_CONTRACTING_ART72`, `isDefault = false`, `applicabilityPriority = 50`, `applicabilityRule` verdadeira quando `process.modalityCode` ∈ {`DISPENSA`, `INEXIGIBILIDADE`}) com sua `WorkflowVersion` 1 `PUBLISHED`, 5 etapas e regras.
3. Ambas as versões recebem `definitionSnapshot`/`definitionHash` (DEC-084) no momento da carga, pela mesma rotina de publicação do editor (US-045).
4. Um administrador acessa **Workflows** (SCR-034) e vê os dois fluxos, com o selo "Padrão" no primeiro.
5. Ao criar um processo (US-001) com modalidade `DISPENSA`, a resolução (`WF-06`/RN-PROC-06) avalia os workflows ativos com versão publicada em ordem de `applicabilityPriority` crescente (50 antes de 100): a regra do workflow de contratação direta casa primeiro e é usada.
6. Para trocar o padrão, o administrador aciona **"Tornar padrão"** na lista; o front envia `POST /api/v1/workflows/{id}/set-default` (`WF-05`) com `If-Match`.
7. A API, em transação: autoriza `WORKFLOW_PUBLISH`; verifica `If-Match`; remove `isDefault` do workflow anterior e marca `isDefault = true` no escolhido; grava auditoria `workflow.set_default` e o evento `WorkflowDefaultChanged`.
8. A API responde 200; o front atualiza os selos na lista.

## Fluxos alternativos
- **FA-01 — Remover o padrão isoladamente:** não existe; a UI só oferece "Tornar padrão" em outro workflow (sempre há exatamente um padrão ativo).
- **FA-02 — Candidato inativo ou sem versão publicada:** a ação "Tornar padrão" fica desabilitada com "Publique uma versão e ative o workflow antes de torná-lo padrão".
- **FA-03 — Dois workflows ativos com a mesma `applicabilityPriority`:** desempate por `createdAt` crescente (determinístico — entities.md, `applicabilityPriority`).
- **FA-04 — Processo com modalidade "A definir" (vazia):** nenhuma `applicabilityRule` que exija modalidade casa; resolve para o `isDefault`.
- **FA-05 — Reexecução do seeder:** reentrada do job não duplica os workflows (`UNIQUE (tenant_id, key)`) e não altera workflows já publicados/editados pelo tenant.

## Regras de negócio
- **RN-WF-34** — O seeder cria exatamente dois `Workflow` por tenant na primeira execução, com `key` estáveis `DEFAULT_PREPARATORY` e `DIRECT_CONTRACTING_ART72` (DEC-001); reexecução é no-op se as chaves já existirem (idempotente).
- **RN-WF-35** — `DEFAULT_PREPARATORY` nasce com `isDefault = true`; `DIRECT_CONTRACTING_ART72` nasce com `isDefault = false` e `applicabilityRule` exigindo `process.modalityCode` em `["DISPENSA", "INEXIGIBILIDADE"]`.
- **RN-WF-36** — As duas `WorkflowVersion` nascem diretamente `status = PUBLISHED`, `versionNumber = 1`, com `definitionSnapshot`/`definitionHash` calculados (DEC-084), sem passar por `DRAFT` — carga inicial, não edição.
- **RN-WF-37** — Etapas, SLAs e `instructions` do workflow padrão seguem DEC-015: 7 etapas (`ABERTURA`…`CONCLUSAO`); SLAs sugeridos em dias úteis (ABERTURA 5, APROVACAO_DFD 3, ESTUDOS 15, PESQUISA 10, TR 10, AUTORIDADE 5; `CONCLUSAO` sem SLA).
- **RN-WF-38** — Etapas do workflow de contratação direta seguem DEC-015: `ABERTURA` → `APROVACAO_DFD` → `INSTRUCAO` → `AUTORIZACAO` → `CONCLUSAO`; regra "TR ou ETP" como `WARNING` e pesquisa de preços concluída como `BLOCKING` na saída de `INSTRUCAO`.
- **RN-WF-39** — Resolução de aplicabilidade (`WF-06`, consumida também por RN-PROC-06): considera apenas `Workflow.isActive = true` com `currentPublishedVersionId` preenchido; avalia em ordem de `applicabilityPriority` crescente e, em empate, `createdAt` crescente; o primeiro cuja `applicabilityRule` for nula ou avaliar verdadeira no `RuleContext.process` vence; sem correspondência, usa o único `isDefault = true`; sem nenhum dos dois, `NO_APPLICABLE_WORKFLOW`.
- **RN-WF-40** — Exatamente um workflow é `isDefault = true` por tenant a qualquer momento (`UNIQUE (tenant_id) WHERE is_default`); `set-default` troca atomicamente o padrão anterior pelo novo.
- **RN-WF-41** — Somente workflow `isActive = true` com versão publicada pode se tornar `isDefault`.
- **RN-WF-42** — `set-default` exige `If-Match` com a `version` do workflow a tornar padrão (DEC-104); divergência → `VERSION_CONFLICT`.

## Campos
Nota: não há formulário de entrada nesta story (os workflows nascem semeados; a troca de padrão é só uma seleção). A tabela documenta os atributos expostos na lista de workflows (SCR-034).

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Nome | `name` | texto | Sim | — | seed (DEC-015) |
| Padrão | `isDefault` | booleano | Sim | único `true` por tenant (RN-WF-40) | seed / `set-default` |
| Prioridade de aplicabilidade | `applicabilityPriority` | número | Sim | menor = avaliado primeiro (RN-WF-39) | 100 (padrão) / 50 (direta) |
| Regra de aplicabilidade | `applicabilityRule` | JSON Logic (somente leitura na lista) | Não | RN-WF-35/39 | seed |
| Ativo | `isActive` | booleano | Sim | RN-WF-41 | `true` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `If-Match` ausente em `set-default` | API | "Recarregue a página e tente novamente." | `PRECONDITION_REQUIRED` |
| V-02 | `If-Match` divergente | API | "Este workflow foi alterado por outra pessoa. Atualize a página." | `VERSION_CONFLICT` |
| V-03 | Workflow inativo ou sem versão publicada tentando ser padrão | API | "Publique uma versão e ative o workflow antes de torná-lo padrão." | `BUSINESS_RULE_VIOLATION` |
| V-04 | Nenhum workflow aplicável nem padrão ao resolver (`WF-06`) | API | "Não há fluxo configurado para este tipo de contratação." | `NO_APPLICABLE_WORKFLOW` |

## Permissões
- **Permissão:** `WORKFLOW_PUBLISH` para `set-default`; `WORKFLOW_VIEW` para listar/resolver.
- **Políticas:** nenhuma política contextual adicional (configuração do tenant, sem processo associado — DEC-010).
- **MFA:** `WORKFLOW_PUBLISH` é ação de risco H; exigida conforme POL-14 e a política de MFA do tenant (`security.mfaPolicy`).
- **Sem permissão:** ação "Tornar padrão" oculta na lista; API responde 403 `PERMISSION_DENIED`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowDefaultChanged` | `workflow.default_changed` | Commit de `set-default` | Não disparado pelo seeder inicial (RN-WF-36 é carga direta); apenas em trocas subsequentes |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma; troca de padrão é configuração silenciosa, como as demais configurações do tenant. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Workflow padrão e seleção por aplicabilidade

  Background:
    Given que o tenant "Prefeitura de São José" está em provisionamento
    And o catálogo "MODALITY" tem os itens ativos "DISPENSA" e "INEXIGIBILIDADE"

  Scenario: [Sucesso] Provisionamento semeia os dois workflows publicados
    When o provisionamento executar o seeder "workflow.seedWorkflows" para o tenant
    Then deve existir o workflow "Fase preparatória — Lei 14.133/2021" publicado e marcado como padrão
    And deve existir o workflow "Contratação direta — Lei 14.133/2021, art. 72" publicado, não padrão
    And ambas as versões devem ter "definitionHash" preenchido

  Scenario: [Sucesso] Processo de dispensa resolve para o workflow de contratação direta
    Given que os dois workflows estão publicados e ativos
    When um processo for criado com modalidade "DISPENSA"
    Then "WF-06" deve resolver o workflow "Contratação direta — Lei 14.133/2021, art. 72"
    And a etapa inicial deve ser "Formalização da demanda" (ABERTURA)

  Scenario: [Validação] Tentar tornar padrão um workflow sem versão publicada
    Given que o workflow "Piloto de obras" não tem versão publicada
    When um administrador tentar marcá-lo como padrão
    Then a API deve responder 422 com código "BUSINESS_RULE_VIOLATION"
    And o workflow "Piloto de obras" não deve se tornar padrão

  Scenario: [Permissão] Usuário sem WORKFLOW_PUBLISH
    Given que "Bruno" possui apenas "WORKFLOW_VIEW"
    When "Bruno" enviar "POST /api/v1/workflows/{id}/set-default"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And o padrão atual não deve ser alterado

  Scenario: [Tenant incorreto] Resolução nunca usa dados de outro tenant
    Given que o tenant "Prefeitura B" tem seus próprios workflows padrão
    When um processo do tenant "Prefeitura de São José" for criado
    Then a resolução deve considerar apenas workflows do tenant "Prefeitura de São José"
    And nunca retornar um workflow do tenant "Prefeitura B"

  Scenario: [Duplicidade] Reexecução do seeder não duplica os workflows
    Given que o tenant já possui os dois workflows semeados
    When o seeder de workflows for executado novamente para o mesmo tenant
    Then deve continuar existindo um único workflow com a chave "DEFAULT_PREPARATORY" e um com "DIRECT_CONTRACTING_ART72"
    And os workflows existentes não devem ser sobrescritos

  Scenario: [Concorrência] Duas trocas de padrão simultâneas
    Given que o workflow "A" é o padrão atual
    When dois administradores tentarem tornar "B" e "C" padrão ao mesmo tempo, cada um com o "If-Match" de "A"
    Then exatamente uma requisição deve ser aceita com 200
    And a outra deve responder 412 com código "VERSION_CONFLICT"
    And ao final deve existir exatamente um workflow com "isDefault: true"

  Scenario: [Falha de banco] Banco indisponível ao trocar o padrão
    Given que o banco de dados fica indisponível
    When um administrador tentar tornar outro workflow padrão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And o padrão anterior deve permanecer inalterado

  Scenario: [Falha de integração] Outbox indisponível ao trocar o padrão
    Given que o relay do outbox está indisponível
    When um administrador tornar outro workflow padrão com sucesso
    Then a API deve responder 200
    And o evento "WorkflowDefaultChanged" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a página e tente novamente." | Recarrega dados |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "Este workflow foi alterado por outra pessoa. Atualize a página." | Recarrega lista |
| Workflow inativo/sem versão publicada | 422 | `BUSINESS_RULE_VIOLATION` | "Publique uma versão e ative o workflow antes de torná-lo padrão." | Desabilita ação; link para o editor |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para alterar o workflow padrão." | Ação oculta |
| Sem workflow aplicável nem padrão | 422 | `NO_APPLICABLE_WORKFLOW` | "Não há fluxo configurado para este tipo de contratação." | Ver US-001 FA-06 |
| Banco/Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Botão "Tentar novamente" |

## Dependências
- **Stories:** US-041 (motor que avalia `applicabilityRule` e consome o workflow resolvido), US-104 (catálogo `MODALITY` com `DISPENSA`/`INEXIGIBILIDADE`). Indiretas: US-099 (provisionamento do tenant; executa o seeder registrado `workflow.seedWorkflows`), US-040 (modelo de definição que o seeder povoa), US-001 (consumidor de `WF-06` na criação do processo).
- **Decisões/ADRs:** DEC-014, DEC-015, DEC-016, DEC-084, DEC-104; ADR-005, ADR-008.
- **Configurações:** nenhuma chave nova; reaproveita `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma (gatilho = seeder registrado no checklist de provisionamento de US-099; desempate de `applicabilityPriority` por `createdAt` registrado em entities.md).

## Impacto técnico
- A carga inicial é o seeder `workflow.seedWorkflows`, registrado no registro de seeders do provisionamento (US-099) e executado em `TenantTransaction` própria, antes da emissão de `TenantProvisioned`; `tenancy` só orquestra, sem conhecer o conteúdo de `workflow` (DEC-040/DEC-041); o seeder deve ser idempotente e retomável.
- `definitionSnapshot`/`definitionHash` do seed são gerados pela mesma rotina de publicação do editor (US-045), evitando dois caminhos de cálculo de hash divergentes.
- `set-default` troca dois registros (antigo e novo padrão) numa única transação com bloqueio de linha para evitar a corrida do cenário de concorrência.

## Backend
- **Módulo(s):** `workflow` (seeder + `set-default`); seeder invocado por `tenancy` (US-099).
- **Casos de uso:** `SeedDefaultWorkflowsOnProvisioning` (seeder `workflow.seedWorkflows`, invocado pelo provisionamento); `SetDefaultWorkflowCommand` → `SetDefaultWorkflowHandler`.
- **Domínio:** `Workflow.markAsDefault()` / `unmarkAsDefault()`; reaproveita `WorkflowVersion.publish(...)` (US-045) para o snapshot da carga inicial.
- **Integrações internas:** `catalog` (validar `MODALITY` referenciado na `applicabilityRule`), `tenancy` (registro de seeders do provisionamento, US-099).
- **Transação:** seed dos dois workflows (+ versões, etapas, transições, regras) em uma transação por workflow; `set-default` em uma transação curta com bloqueio dos dois registros envolvidos.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows`) — lista com selo "Padrão" e ação "Tornar padrão".
- **Componentes:** `WorkflowList`, `DefaultBadge`, `SetDefaultButton` (com confirmação).
- **Estados:** skeleton na lista; "Tornar padrão" desabilitado para workflow inativo/sem versão publicada; toast "Workflow X agora é o padrão".
- **Acessibilidade e responsividade:** selo "Padrão" com ícone + texto (não só cor); lista em cartões responsivos abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflows`, `workflow_versions`, `workflow_stages`, `workflow_transitions`, `workflow_rules` (inserção pelo seeder); nenhuma tabela nova.
- **Migrações:** nenhuma estrutural; carga de dados (seed) versionada junto ao código como script determinístico.
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, key)` e `UNIQUE (tenant_id) WHERE is_default` em `workflows` (US-040) garantem a unicidade das chaves semeadas e do padrão.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-05 | POST | `/api/v1/workflows/{id}/set-default` | — (`If-Match` obrigatório) | `200 { data: Workflow }` com `isDefault: true` | 200, 403, 404, 412, 422, 428, 503 |
| WF-06 | POST | `/api/v1/workflows/resolve` | `{ contractingTypeId, modalityId?, originId, estimatedValue?, organizationId, isPriceRegistration }` | `200 { data: { workflowId, name, versionNumber, initialStage } }` | 200, 422 (`NO_APPLICABLE_WORKFLOW`) |

## Logs
- `info` `workflow.seeded` — `tenantId`, as duas `workflowId`/`versionId` criadas, `durationMs`.
- `info` `workflow.default_changed` — `previousWorkflowId`, `newWorkflowId`.
- `warn` `workflow.seed_skipped_existing` — reentrada do seeder sem efeito (RN-WF-34).
- `error` `workflow.seed_failed` — causa, `correlationId`.
- **Nunca logar:** não se aplica (sem dados pessoais/sigilosos nesta story).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.create` + `workflow.version_publish` | `CONFIGURATION` | Carga inicial (seeder) | Ator `SYSTEM`; `metadata`: `key`, `versionNumber = 1`, `definitionHash` |
| `workflow.set_default` | `CONFIGURATION` | Commit de `set-default` | `changes`: `isDefault` do antigo (true→false) e do novo (false→true); `metadata`: `previousWorkflowId` |
| `access.denied` | `ACCESS` | Tentativa sem `WORKFLOW_PUBLISH` | `reasonCode = WORKFLOW_PUBLISH` |

## Testes necessários
- **Unitários:** resolução de aplicabilidade (RN-WF-39) com prioridades, empates e ausência de regra; `markAsDefault`/`unmarkAsDefault`.
- **Integração (Testcontainers PostgreSQL):** seeder cria exatamente os dois workflows com o conteúdo de DEC-015; reexecução idempotente; RLS isola por tenant.
- **API/contrato:** `WF-05`/`WF-06` conforme api.md.
- **RBAC e multi-tenant:** `WORKFLOW_PUBLISH` vs. `WORKFLOW_VIEW`; resolução nunca cruza tenant.
- **Concorrência:** duas trocas de padrão simultâneas → uma 200, outra 412.
- **E2E (Playwright):** "tornar padrão" na lista de workflows; criação de processo de dispensa resolvendo o workflow correto.
- **Acessibilidade/performance:** axe na lista SCR-034; `WF-06` com p95 < 100 ms.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados (API + E2E) e passando no CI
- [ ] Seeder idempotente coberto por teste de reexecução
- [ ] `WORKFLOW_PUBLISH`/`WORKFLOW_VIEW` aplicados; ação oculta sem permissão
- [ ] Exatamente um workflow `isDefault` garantido por constraint e por teste de concorrência
- [ ] Auditoria `workflow.set_default` e evento `WorkflowDefaultChanged` verificados em teste
- [ ] OpenAPI de WF-05 e WF-06 compatível com api.md
- [ ] Logs sem dados sensíveis; métricas e trace presentes
- [ ] Lista acessível (axe) e responsiva
- [ ] Revisão de código e de segurança aprovadas

## Estimativa
**M** — conteúdo de domínio bem definido (DEC-015) e poucas transições de estado, mas depende do motor (US-041) e do gatilho de provisionamento (US-099).

## Prioridade
**P0** — sem workflow padrão semeado, a criação de processo (US-001) falha para todo tenant novo.
