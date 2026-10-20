---
id: US-045
title: "Publicar, versionar e aposentar workflow"
epic: EP-007
feature: FT-030
mvp: 1
priority: P1
estimate: M
status: Especificada
depends_on: [US-043]
modules: [workflow]
screens: [SCR-034]
endpoints: [WF-07, WF-08, WF-20, WF-21, WF-22]
permissions: [WORKFLOW_VIEW, WORKFLOW_MANAGE, WORKFLOW_PUBLISH]
events: [WorkflowVersionPublished, WorkflowVersionRetired]
---

# US-045 — Publicar, versionar e aposentar workflow

## Título
Publicar, versionar e aposentar workflow

## Descrição
**Como** administrador do órgão, **quero** validar, publicar e aposentar versões de um workflow, e criar uma nova versão a partir da publicada, **para** colocar em produção um fluxo revisado sem afetar os processos que já estão em andamento na versão anterior.

A aba "Versões" do editor (SCR-034) lista o histórico de `WorkflowVersion` do workflow, com status, autor e data. A partir do rascunho corrente, o administrador roda a validação (`WF-20`), corrige erros bloqueantes e publica (`WF-21`); a versão publicada vira imutável e passa a valer para novos processos. Versões antigas podem ser aposentadas (`WF-22`) quando não forem mais a opção corrente, e uma nova versão rascunho pode ser criada a qualquer momento a partir da publicada (`WF-08`, já usado pela US-043).

## Contexto
- `WorkflowVersion` segue o ciclo `DRAFT → PUBLISHED → RETIRED`, e a publicada é imutável (DEC-014); isso garante que processos já criados nunca mudem de regras por baixo dos pés (`Process.workflowVersionId` fixado — DEC-014).
- A validação de grafo (`WF_*`, api.md §2.3) existe desde US-040 como catálogo de erros/avisos, mas nenhuma story anterior executa essa validação nem publica de fato uma versão — US-043 só cria/edita o rascunho.
- Snapshots imutáveis com hash (DEC-084) já são o padrão do produto para versões de documento e de template; o workflow publicado segue a mesma regra.

## Objetivo
Permitir publicar uma versão de workflow validada em menos de 1 minuto, com 100% das versões publicadas possuindo snapshot e hash gravados, e garantir que nenhum processo em andamento mude de versão ao publicar ou aposentar outras versões.

## Persona
- **Principal:** Administrador do órgão (perfil `ADMIN_ORGAO`, com `WORKFLOW_PUBLISH`).
- **Secundárias:** Gestor de contratações com `WORKFLOW_MANAGE` (valida e prepara, mas não publica sem `WORKFLOW_PUBLISH`).

## Pré-condições
- Existe uma `WorkflowVersion` em `DRAFT` com etapas e transições (US-043), opcionalmente com regras (US-044).
- Usuário com `WORKFLOW_PUBLISH` para publicar/aposentar; `WORKFLOW_MANAGE`/`WORKFLOW_VIEW` para validar/consultar.

## Fluxo principal
1. Na aba "Versões" (SCR-034), o administrador vê a lista (`WF-07`): versão corrente em `DRAFT`, histórico de `PUBLISHED`/`RETIRED` com `versionNumber`, `publishedAt`, `changeNotes`.
2. Ele clica em **"Validar"**; o front chama `POST /api/v1/workflow-versions/{versionId}/validate` (`WF-20`), que retorna `errors[]` (bloqueantes) e `warnings[]` (`WF_*`, api.md §2.3) com referência a `stageKey`/`transitionKey`/`ruleId`.
3. O sistema lista os problemas; enquanto houver `errors[]`, o botão "Publicar" fica desabilitado.
4. Sem erros, o administrador preenche **"Notas da versão"** (`changeNotes` — obrigatório a partir da v2) e clica em **"Publicar"**.
5. O front envia `POST /api/v1/workflow-versions/{versionId}/publish` (`WF-21`) com `If-Match`. A API revalida (mesma regra do `WF-20`), calcula o snapshot canônico e o hash (DEC-084), grava `status = PUBLISHED`, `publishedAt`/`publishedById`, atualiza `Workflow.currentPublishedVersionId` e publica `WorkflowVersionPublished`.
6. A versão publicada passa a ser somente leitura; o front oferece **"Criar novo rascunho"** (`WF-08`, US-043) para a próxima revisão.
7. Para desativar uma versão antiga já substituída, o administrador abre seu histórico e clica em **"Aposentar"**; o front envia `POST /api/v1/workflow-versions/{versionId}/retire` (`WF-22`) com `If-Match`, a API grava `status = RETIRED`, `retiredAt`/`retiredById` e publica `WorkflowVersionRetired`.

## Fluxos alternativos
- **FA-01 — Validação com apenas avisos:** `WF-20` retorna só `warnings[]`; o botão "Publicar" fica habilitado e os avisos são exibidos como lista informativa (não exigem reconhecimento explícito nesta story).
- **FA-02 — Primeira publicação (v1):** `changeNotes` é opcional; demais publicações exigem o campo preenchido (RN-WF-63).
- **FA-03 — Aposentar a versão corrente sem substituta:** a API responde `WORKFLOW_IN_USE`; o front explica "Publique uma nova versão antes de aposentar esta" (RN-WF-66).
- **FA-04 — Workflow inteiro sendo descontinuado:** o administrador desativa o `Workflow` (`isActive=false`, `WF-04`, fora desta story) antes de aposentar a última versão publicada.
- **FA-05 — Publicar sem etapa inicial definida:** `WF-20`/`WF-21` retornam erro bloqueante `WF_START_STAGE_COUNT` (já catalogado); o front leva o administrador à aba "Etapas" (US-043) para corrigir.

## Regras de negócio
- **RN-WF-61** — Publicar (`WF-21`) exige validação (`WF-20`) sem `errors[]`; `warnings[]` não bloqueiam a publicação.
- **RN-WF-62** — Publicar exige `WorkflowVersion.initialStageId` definido, apontando para uma etapa `START` da própria versão (entities.md §4).
- **RN-WF-63** — `changeNotes` é obrigatório para publicar a partir da segunda versão (`versionNumber ≥ 2`); opcional na primeira.
- **RN-WF-64** — Ao publicar: grava `definitionSnapshot` (JSON canonicalizado RFC 8785/JCS de etapas, transições e regras) e `definitionHash` (SHA-256, DEC-084); define `status = PUBLISHED`, `publishedAt`, `publishedById`; atualiza `Workflow.currentPublishedVersionId` para esta versão.
- **RN-WF-65** — Após publicada, a versão é imutável: o trigger de banco (entities.md §4, "Imutabilidade") bloqueia qualquer alteração em `workflow_stages`, `workflow_transitions` e `workflow_rules` dessa versão.
- **RN-WF-66** — Aposentar (`WF-22`) só se aplica a versão `PUBLISHED`; é bloqueado com `WORKFLOW_IN_USE` quando a versão for a `currentPublishedVersionId` do seu `Workflow` e este estiver `isActive = true` (ou for o padrão — RN-WF-41) sem outra versão `PUBLISHED` para assumir o papel de corrente. Havendo outra `PUBLISHED`, a de maior número assume; fora de uso (inativo e não padrão — FA-04), o workflow fica sem publicada (`currentPublishedVersionId = null`). Como a publicação supersede a anterior (RN-WF-20 · US-040), na prática a corrente é a única `PUBLISHED`.
- **RN-WF-67** — Processos que já fixaram `workflowVersionId` (DEC-014) continuam nessa versão independentemente de publicações ou aposentadorias de outras versões do mesmo workflow.
- **RN-WF-68** — Um workflow tem no máximo uma `WorkflowVersion` em `DRAFT` por vez (RN-WF-46); criar uma nova versão (`WF-08`) exige que exista uma versão `PUBLISHED` para copiar (RN-WF-47).
- **RN-WF-69** — O histórico (`WF-07`) é ordenado por `versionNumber` decrescente e traz `status`, `publishedAt`, `retiredAt` e `changeNotes` de cada versão.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Notas da versão | `changeNotes` | texto longo | Condicional (v≥2) | RN-WF-63 | — |
| *(leitura)* Número da versão | `versionNumber` | número | — | sequencial | gerado |
| *(leitura)* Status | `status` | seleção (`WorkflowVersionStatus`) | — | enum | gerado |
| *(leitura)* Publicada em / por | `publishedAt`, `publishedById` | data/seleção | — | RN-WF-64 | gerado |
| *(leitura)* Aposentada em / por | `retiredAt`, `retiredById` | data/seleção | — | RN-WF-66 | gerado |
| *(leitura)* Erros/avisos de validação | `errors[]`, `warnings[]` | lista | — | api.md §2.3 | `WF-20` |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Publicar com `errors[]` pendentes | API | "Corrija os problemas indicados antes de publicar." | `WORKFLOW_INVALID` |
| V-02 | `changeNotes` ausente a partir da v2 | Front + API | "Descreva o que mudou nesta versão." | `VALIDATION_ERROR` (`CONDITIONAL_REQUIRED`) |
| V-03 | Publicar/aposentar versão que não está no status esperado | API | "Esta versão não pode mais ser publicada/aposentada." | `INVALID_STATE` |
| V-04 | Aposentar a única versão aplicável | API | "Publique uma nova versão antes de aposentar esta." | `WORKFLOW_IN_USE` |
| V-05 | `If-Match` ausente/divergente | API | "Os dados foram alterados. Recarregue e tente novamente." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-06 | Criar versão sem publicada existente | API | "Não há versão publicada para copiar." | `BUSINESS_RULE_VIOLATION` |
| V-07 | Criar versão quando já existe rascunho | API | "Já existe um rascunho deste workflow." | `WORKFLOW_DRAFT_EXISTS` |

## Permissões
- **Permissão:** `WORKFLOW_VIEW` para consultar histórico/validação; `WORKFLOW_MANAGE` para criar nova versão (`WF-08`); `WORKFLOW_PUBLISH` para publicar (`WF-21`) e aposentar (`WF-22`).
- **Políticas:** nenhuma política contextual adicional (ação é sobre configuração do tenant, não sobre processo).
- **MFA:** `security.mfaPolicy` pode exigir MFA para `WORKFLOW_PUBLISH` (risco `H`) quando `POL-14` estiver ativa para o tenant.
- **Sem permissão:** botões "Publicar"/"Aposentar" ocultos sem `WORKFLOW_PUBLISH` (ficam visíveis, desabilitados com tooltip, para quem só tem `WORKFLOW_MANAGE`); API responde 403 `PERMISSION_DENIED` e registra `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `WorkflowVersionPublished` | `workflow.version_published` | Commit da publicação | Payload: `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash` |
| `WorkflowVersionRetired` | `workflow.version_retired` | Commit da aposentadoria | Payload: `workflowId`, `workflowVersionId` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma nesta story; publicação de workflow não gera notificação a usuários finais no MVP 1 |

## Critérios de aceite em Gherkin
```gherkin
Feature: Publicar, versionar e aposentar workflow

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o workflow "Fase preparatória — Lei 14.133/2021" com a versão 1 "PUBLISHED" e uma versão 2 em "DRAFT"
    And a administradora "Carla" possui "WORKFLOW_PUBLISH"

  Scenario: [Sucesso] Publicar uma nova versão validada
    Given que a versão 2 não tem erros bloqueantes na validação
    When "Carla" informar as notas da versão e clicar em "Publicar"
    Then a versão 2 deve ficar com status "PUBLISHED"
    And "Workflow.currentPublishedVersionId" deve apontar para a versão 2
    And deve gerar o evento "WorkflowVersionPublished"
    And deve gerar registro de auditoria "workflow.version_publish"

  Scenario: [Validação] Publicar sem notas da versão
    When "Carla" clicar em "Publicar" sem preencher as notas da versão
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "changeNotes"
    And a versão 2 deve permanecer "DRAFT"

  Scenario: [Permissão] Gestor sem WORKFLOW_PUBLISH tenta publicar
    Given que "Diego" possui apenas "WORKFLOW_MANAGE"
    When "Diego" enviar POST para publicar a versão 2
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And deve gerar registro de auditoria "access.denied"

  Scenario: [Tenant incorreto] Publicar versão de outro tenant
    When "Carla", autenticada na "Prefeitura de São José", enviar POST de publicação para uma "workflowVersionId" da "Prefeitura B"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nenhum dado do tenant "Prefeitura B" deve ser alterado

  Scenario: [Duplicidade] Criar nova versão quando já existe um rascunho
    When "Carla" acionar "Criar novo rascunho" com a versão 2 ainda em "DRAFT"
    Then a API deve responder 409 com código "WORKFLOW_DRAFT_EXISTS"

  Scenario: [Concorrência] Duas publicações simultâneas da mesma versão
    Given que "Carla" e "Diego" abrem a versão 2 com "ETag" "5"
    When "Diego" publicar primeiro e "Carla" enviar "POST" de publicação com "If-Match" "5"
    Then a API deve responder 412 com código "VERSION_CONFLICT"
    And deve existir apenas uma publicação da versão 2

  Scenario: [Falha de banco] Banco indisponível ao publicar
    Given que o banco de dados fica indisponível durante a publicação
    When "Carla" clicar em "Publicar"
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE"
    And a versão 2 deve permanecer "DRAFT" sem snapshot gravado

  Scenario: [Falha de integração] Outbox indisponível ao publicar
    Given que o relay do outbox está indisponível
    When "Carla" publicar a versão 2 com sucesso
    Then a API deve responder 200 e a versão deve ficar "PUBLISHED"
    And o evento "WorkflowVersionPublished" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Erros bloqueantes de validação | 422 | `WORKFLOW_INVALID` | "Corrija os problemas indicados antes de publicar." | Lista `errors[]` com link para o item |
| Notas da versão ausentes | 422 | `VALIDATION_ERROR` | "Descreva o que mudou nesta versão." | Foca o campo |
| Status incompatível | 409 | `INVALID_STATE` | "Esta versão não pode mais ser publicada/aposentada." | Atualiza a lista de versões |
| Versão em uso | 409 | `WORKFLOW_IN_USE` | "Publique uma nova versão antes de aposentar esta." | Sugere "Criar novo rascunho" |
| Rascunho já existe | 409 | `WORKFLOW_DRAFT_EXISTS` | "Já existe um rascunho deste workflow." | Link para o rascunho |
| `If-Match` ausente/divergente | 428/412 | `PRECONDITION_REQUIRED`/`VERSION_CONFLICT` | "Os dados foram alterados. Recarregue." | Recarrega recurso |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para publicar workflows." | Desabilita botão com tooltip |

## Dependências
- **Stories:** US-043 (rascunho, etapas e transições a publicar); US-044 (regras incluídas no snapshot); US-040 (catálogo `WF_*` de validação do grafo).
- **Decisões/ADRs:** DEC-014, DEC-016, DEC-084, DEC-104, DEC-105; ADR-005.
- **Configurações:** `security.mfaPolicy`.
- **Lacunas nas fontes canônicas:** nenhuma.
- **Decisões da implementação (2026-10-16):** `If-Match` é conferido antes do status (a segunda publicação simultânea recebe 412, não 409); `WF-20` devolve também `valid`; `WF-07` traz `publishedByName`/`retiredByName` para a coluna "por"; "Publicar" no SCR-034 só habilita depois de uma validação sem `errors[]`.

## Impacto técnico
- `WF-20` e `WF-21` devem compartilhar o mesmo validador de grafo para que "Publicar" nunca aceite algo que "Validar" não sinalizou (mesma função pura, chamada duas vezes: uma de leitura, outra dentro da transação de publicação).
- Cálculo de `definitionSnapshot`/`definitionHash` segue o mesmo utilitário de canonicalização (RFC 8785/JCS) usado por versões de documento e template (DEC-084) — reaproveitar, não reimplementar.
- `Workflow.currentPublishedVersionId` e o `status` da versão são atualizados na mesma transação do `WF-21`/`WF-22`; nenhuma leitura externa pode observar um estado intermediário.

## Backend
- **Módulo(s):** `workflow` (dono).
- **Casos de uso:** `ValidateWorkflowVersionQuery`, `PublishWorkflowVersionCommand`, `RetireWorkflowVersionCommand`, `ListWorkflowVersionsQuery`.
- **Domínio:** `WorkflowGraphValidator` (produz `errors[]`/`warnings[]` `WF_*`); `WorkflowVersion.publish(...)`/`retire(...)`; `SnapshotCanonicalizer` (JCS + SHA-256).
- **Integrações internas:** `audit` (`AuditService`), `platform` (`OutboxWriter`).
- **Transação:** `WF-21`/`WF-22` em transação única: valida (se aplicável), atualiza status/timestamps, grava snapshot/hash, atualiza `Workflow.currentPublishedVersionId` (só no publish), grava auditoria e outbox.

## Frontend
- **Tela(s):** SCR-034 (`/admin/workflows/[id]`), aba "Versões".
- **Componentes:** `VersionList` (histórico), `ValidationResultPanel` (`errors[]`/`warnings[]` com link para `stageKey`/`transitionKey`/`ruleId`), `PublishDialog` (notas da versão), `RetireConfirmDialog`.
- **Estados:** skeleton na lista; botão "Publicar" desabilitado com tooltip enquanto houver erros; sucesso com toast "Versão 2 publicada".
- **Acessibilidade e responsividade:** lista de erros navegável por teclado com foco no primeiro item; diálogos de confirmação com foco preso (focus trap); lista de versões em cartões abaixo de 768 px.

## Banco de dados
- **Tabelas:** `workflow_versions` (escrita de status/snapshot/hash/timestamps), `workflows` (escrita de `currentPublishedVersionId`); leitura de `workflow_stages`/`workflow_transitions`/`workflow_rules` para validar e gerar o snapshot.
- **Migrações:** nenhuma (campos já definidos em entities.md §4, US-040).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, workflow_id, version_number)`; trigger de imutabilidade pós-`DRAFT` (entities.md).

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| WF-07 | GET | `/api/v1/workflows/{id}/versions` | — | `200 { data: WorkflowVersion[] }` ordenado por `versionNumber` desc | 200, 404 |
| WF-08 | POST | `/api/v1/workflows/{id}/versions` | — | `201 { data: WorkflowVersion }` (cópia da publicada) | 201, 403, 409 |
| WF-20 | POST | `/api/v1/workflow-versions/{versionId}/validate` | — | `200 { data: { errors: [{ code, stageKey?, transitionKey?, ruleId? }], warnings: [...] } }` | 200, 404 |
| WF-21 | POST | `/api/v1/workflow-versions/{versionId}/publish` | `{ changeNotes? }` + `If-Match` | `200 { data: WorkflowVersion }` | 200, 403, 409, 412, 422, 428 |
| WF-22 | POST | `/api/v1/workflow-versions/{versionId}/retire` | `If-Match` | `200 { data: WorkflowVersion }` | 200, 403, 409, 412, 428 |

## Logs
- `info` `workflow.version_published` — `workflowId`, `workflowVersionId`, `versionNumber`, `definitionHash`, `durationMs`.
- `info` `workflow.version_retired` — `workflowId`, `workflowVersionId`.
- `warn` `workflow.publish_blocked` — quantidade de `errors[]` que impediram a publicação.
- `error` `workflow.publish_failed` — causa, `correlationId`.
- **Nunca logar:** conteúdo integral do snapshot (apenas o hash e contadores).

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `workflow.version_publish` | `CONFIGURATION` | Commit da publicação | `metadata`: `versionNumber`, `definitionHash`, `changeNotes` |
| `workflow.version_retire` | `CONFIGURATION` | Commit da aposentadoria | `metadata`: `versionNumber` |
| `access.denied` | `ACCESS` | Tentativa sem permissão | `reasonCode = WORKFLOW_PUBLISH` |

## Testes necessários
- **Unitários:** `WorkflowGraphValidator` (cada código `WF_*`); `SnapshotCanonicalizer` (determinismo do hash); regras RN-WF-61..69.
- **Integração (Testcontainers):** publicar grava snapshot/hash e atualiza `currentPublishedVersionId` atomicamente; aposentar bloqueia `WORKFLOW_IN_USE` corretamente; trigger de imutabilidade pós-publicação.
- **Concorrência:** duas publicações simultâneas da mesma versão → uma 200, outra 412; duas criações de rascunho simultâneas → uma 201, outra 409.
- **API/contrato:** respostas conforme tabela API; cabeçalhos `If-Match`/`ETag`.
- **RBAC e multi-tenant:** `WORKFLOW_MANAGE` não publica; versão de outro tenant → 404.
- **E2E (Playwright):** validar → corrigir erro → publicar → aposentar versão antiga.
- **Acessibilidade/performance:** axe nos diálogos; publicação com p95 < 800 ms incluindo cálculo de snapshot.

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

## Estimativa
**M** — reaproveita validação (`WF_*` já catalogado em US-040) e snapshot canônico (padrão já usado em documentos/templates); o trabalho novo é orquestrar publish/retire/validate com as transições de status e os eventos.

## Prioridade
**P1** — sem publicação, nenhuma alteração feita no editor (US-043/US-044) chega a valer para novos processos; mas o workflow padrão semeado (US-042) já cobre o MVP 1 sem esta story.
