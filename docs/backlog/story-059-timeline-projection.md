---
id: US-059
title: "Projetar eventos do processo na timeline"
epic: EP-010
feature: FT-037
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-082]
modules: [timeline]
screens: []
endpoints: []
permissions: []
events: []
---

# US-059 — Projetar eventos do processo na timeline

## Título
Projetar eventos do processo na timeline

## Descrição
**Como** sistema, **quero** projetar de forma síncrona e idempotente os eventos de domínio do processo em entradas de timeline legíveis, **para** que qualquer pessoa que visualize o processo (US-060) acompanhe sua narrativa sem depender da auditoria técnica.

O `TimelineProjector` é um handler síncrono in-process (DEC-161): ao final de cada caso de uso que publica um evento de domínio, dentro da mesma transação, ele resolve o `type` de timeline correspondente (registro `TimelineEntryType`, events.md §5), congela nomes e rótulos no momento do fato, calcula a visibilidade (`STANDARD` ou `BUDGET_RESTRICTED`, POL-09) e grava uma `ProcessTimelineEntry` de forma idempotente (`sourceEventId` + `type`). Não é um mecanismo de auditoria (DEC-025): é uma projeção de leitura curada para narrativa de negócio.

## Contexto
- Hoje não existe uma visão única e confiável de "o que aconteceu com o processo"; a informação está espalhada entre tramitações, documentos, aprovações, comentários e logs técnicos.
- DEC-025 separa explicitamente timeline (narrativa de negócio, visível a quem vê o processo) de auditoria (evidência de conformidade, visível a quem tem `AUDIT_VIEW`); esta story implementa apenas a primeira.
- DEC-161 define que a entrega de eventos de domínio é feita via `outbox_events` na mesma transação da mudança de estado, com dois handlers síncronos in-process: `ProcessAccess` e a timeline (esta story). Os demais consumidores (notificações, e-mail, busca) são assíncronos, via relay do outbox.
- Esta é uma story fundacional e transversal: qualquer caso de uso de outro módulo (processo, documento, aprovação, comentário, anexo, risco, pesquisa de preço, termo de referência) que publique um evento mapeado na tabela de Regras de negócio passa a depender desta projeção para considerar sua própria Definition of Done completa — como já ocorre com US-001 (criação de processo), que lista esta story como dependência.

## Objetivo
Garantir que 100% dos eventos elegíveis (tabela de Regras de negócio) gerem exatamente uma `ProcessTimelineEntry`, de forma síncrona e transacional, sem duplicidade mesmo sob reprocessamento do mesmo evento, e sem expor entradas `BUDGET_RESTRICTED` fora da política POL-09 — base para a leitura paginada da US-060.

## Persona
- **Principal:** o próprio processo (ator técnico) — qualquer caso de uso de domínio que gere um evento elegível (criação, tramitação, aprovação, documento, comentário, risco, pesquisa de preço). Não há interação humana direta nesta story.
- **Secundárias:** todas as personas que acompanham o processo via US-060 (Requisitante, Gestor de Contratações, Autoridade, Controle Interno, Planejamento) — beneficiárias indiretas da narrativa gerada.

## Pré-condições
- Evento de domínio gravado em `outbox_events` na mesma transação da mudança de estado (DEC-161).
- Existe mapeamento do `type` do evento (e de seu discriminador, quando houver) para um `TimelineEntryType` na tabela de Regras de negócio.
- O processo (`processId`) do evento existe e pertence ao mesmo `tenantId`.

## Fluxo principal
1. Um caso de uso de domínio (ex.: `CreateProcessHandler`, `ForwardProcessHandler`, `SubmitDocumentHandler`) conclui a mudança de estado dentro de uma transação e grava o evento em `outbox_events`, obtendo `eventId`.
2. Na mesma transação, o caso de uso invoca o `TimelineProjector.project(event)` (handler síncrono in-process — DEC-161).
3. O projetor localiza, na tabela de mapeamento (Regras de negócio), a linha correspondente ao nome do evento e ao seu discriminador quando houver (ex.: `MovementAction` de `ProcessStageChanged` define se o `type` é `PROCESS_FORWARDED`, `PROCESS_RETURNED` ou `PROCESS_STAGE_CHANGED`).
4. O projetor resolve os `params` da mensagem a partir do payload do evento, "congelando" nomes e rótulos (ator, unidade, documento, catálogo) no momento do fato.
5. O projetor resolve a `visibility` (`STANDARD` ou `BUDGET_RESTRICTED`) conforme a tabela e POL-09.
6. O projetor insere `ProcessTimelineEntry` com `INSERT … ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING`, usando `sourceEventId = event.id`.
7. A transação do caso de uso de origem é confirmada, incluindo a entrada de timeline; se qualquer etapa falhar, tudo é revertido junto.
8. Em caso de reprocessamento do mesmo evento (ex.: ferramenta de suporte reexecutando um backfill), a segunda tentativa de inserção é absorvida pela constraint de unicidade, sem erro e sem duplicar a entrada.

## Fluxos alternativos
- **FA-01 — Evento sem mapeamento:** evento de domínio cujo nome não consta na tabela de Regras de negócio é ignorado pelo projetor (RN-TML-07); a transação de origem segue normalmente.
- **FA-02 — Evento com múltiplos destinos possíveis:** eventos com discriminador (ex.: `ProcessStageChanged`, `ProcessAssigned`, `ProcessStatusChanged`) resolvem o `type` a partir do campo discriminador do payload (ex.: `MovementAction`), conforme a tabela.
- **FA-03 — Entrada orçamentária sigilosa:** evento que altera ou resume valores de processo com `isBudgetConfidential = true` (ex.: `PROCESS_UPDATED` incluindo `estimatedValue`) gera entrada com `visibility = BUDGET_RESTRICTED`.
- **FA-04 — Reprocessamento manual (backfill):** replay de eventos históricos (ex.: após correção de um bug de mapeamento) não duplica entradas já existentes (RN-TML-03).
- **FA-05 — Entidade referenciada posteriormente renomeada ou inativada:** a entrada já gravada mantém os nomes congelados no momento do fato (RN-TML-04); a tela de timeline (US-060) nunca refaz o `join` com o estado atual.

## Regras de negócio
- **RN-TML-01** — A projeção ocorre de forma síncrona, dentro da mesma transação do caso de uso que originou o evento (DEC-161); falha na projeção reverte a transação inteira (nenhuma mudança de estado é persistida sem a entrada de timeline correspondente).
- **RN-TML-02** — O projetor mapeia cada evento elegível a um `TimelineEntryType` conforme a tabela abaixo (events.md §5):

| `type` | Evento de origem | Mensagem (pt-BR) | `params` principais | Visibilidade |
|---|---|---|---|---|
| `PROCESS_CREATED` | `ProcessCreated` | "{actor} abriu o processo {code}" | `code`, `title`, `requestingDepartmentName` | STANDARD |
| `PROCESS_DUPLICATED_FROM` | `ProcessCreated` (com `duplicatedFromId`) | "Processo criado a partir de {sourceCode}" | `sourceCode` | STANDARD |
| `PROCESS_UPDATED` | `ProcessUpdated` | "{actor} alterou {fieldsLabel}" | `fields[]` | `BUDGET_RESTRICTED` se incluir `estimatedValue` com sigilo |
| `PROCESS_NUMBER_ASSIGNED` | `ProcessNumberAssigned` | "Processo autuado sob o nº {code}" | `code` | STANDARD |
| `ITEMS_CHANGED` | `ProcessItemsChanged` | "{actor} atualizou os itens ({itemsCount})" | contagens | STANDARD |
| `PROCESS_FORWARDED` | `ProcessStageChanged` (`FORWARD`) | "{actor} encaminhou para {toStageName} — {toDepartmentName}" | `fromStageName`, `toStageName`, `toDepartmentName`, `toUserName?`, `dueAt`, `documents[]`, `hasComment` | STANDARD |
| `PROCESS_RETURNED` | `ProcessStageChanged` (`RETURN`) | "{actor} devolveu para {toStageName} — {toDepartmentName}" | idem | STANDARD |
| `PROCESS_STAGE_CHANGED` | `ProcessStageChanged` (`APPROVAL_*`, `COMPLETE`) | "Processo seguiu para {toStageName}" | idem + `decision` | STANDARD |
| `PROCESS_CLAIMED` | `ProcessAssigned` (`CLAIM`) | "{actor} assumiu o processo" | — | STANDARD |
| `PROCESS_ASSIGNED` | `ProcessAssigned` (`MANUAL`) | "{actor} atribuiu o processo a {toUserName}" | `toUserName`, `fromUserName?` | STANDARD |
| `PROCESS_SUSPENDED` / `PROCESS_RESUMED` | `ProcessStatusChanged` | "{actor} suspendeu/retomou o processo" | `reason` (texto) | STANDARD |
| `PROCESS_CANCELED` | `ProcessStatusChanged` | "{actor} cancelou o processo" | `reason` | STANDARD |
| `PROCESS_COMPLETED` | `ProcessStatusChanged` | "Planejamento da contratação concluído" (MVP 1 — DEC-015) | — | STANDARD |
| `PARTICIPANT_ADDED` / `PARTICIPANT_REMOVED` | `ProcessParticipantAdded` / `ProcessParticipantRemoved` | "{actor} adicionou {name} como {roleLabel}" | `name`, `role`, `expiresAt?` | STANDARD |
| `CONFIDENTIALITY_CHANGED` | `ProcessConfidentialityChanged` | "{actor} marcou o orçamento como sigiloso / público" | — | STANDARD |
| `STAGE_OVERDUE` | `ProcessStageOverdue` | "Prazo da etapa {stageName} vencido" | `stageName`, `dueAt` | STANDARD |
| `DOCUMENT_CREATED` | `DocumentCreated` | "{actor} criou {documentLabel}" | `documentCode`, `documentTitle`, `typeName` | STANDARD |
| `DOCUMENT_VERSION_CREATED` | `DocumentVersionCreated` | "{actor} gerou a versão {versionNumber} de {documentLabel}" | `versionNumber`, `reason` | STANDARD |
| `DOCUMENT_SUBMITTED` / `DOCUMENT_FINALIZED` | `DocumentSubmitted` / `DocumentFinalized` | "{actor} submeteu/concluiu {documentLabel}" | — | STANDARD (`BUDGET_RESTRICTED` para resumo de valores) |
| `DOCUMENT_APPROVED` / `DOCUMENT_RETURNED` / `DOCUMENT_REJECTED` | `DocumentApproved` / `DocumentReturned` / `DocumentRejected` | "{documentLabel} aprovado/devolvido/indeferido" | `approverName` | STANDARD |
| `DOCUMENT_REOPENED` / `DOCUMENT_CANCELED` / `DOCUMENT_WITHDRAWN` | `DocumentReopened` / `DocumentCanceled` / `DocumentWithdrawn` | "{actor} reabriu/cancelou/retirou {documentLabel}" | `reason?` | STANDARD |
| `APPROVAL_REQUESTED` | `ApprovalRequested` | "Aprovação solicitada a {approverLabel}" | `approverLabel`, `dueAt` | STANDARD |
| `APPROVAL_DECIDED` | `ApprovalCompleted` / `ApprovalReturned` / `ApprovalRejected` | "{actor} {decisionLabel} — {title}" | `decision`, `asDeputy`, `hasComment` | STANDARD |
| `APPROVAL_CANCELED` / `APPROVAL_REASSIGNED` | `ApprovalCanceled` / `ApprovalReassigned` | "Aprovação cancelada/redirecionada" | `reason`, `toApproverLabel?` | STANDARD |
| `COMMENT_ADDED` | `CommentCreated` | "{actor} comentou" (+ trecho de até 140 caracteres) | `excerpt`, `documentLabel?` | STANDARD |
| `COMMENT_REMOVED` | `CommentDeleted` (moderação) | "Comentário removido por moderação" | — | STANDARD |
| `ATTACHMENT_ADDED` / `ATTACHMENT_REMOVED` | `AttachmentUploaded` / `AttachmentDeleted` | "{actor} anexou/removeu {fileName}" | `fileName`, `targetLabel` | STANDARD |
| `ETP_ALTERNATIVE_RECOMMENDED` | `EtpAlternativeRecommended` | "{actor} definiu a alternativa recomendada: {name}" | `name` | STANDARD |
| `QUOTATION_EXCLUDED` / `QUOTATION_RESTORED` | `QuotationExcluded` / `QuotationRestored` | "{actor} desconsiderou/restaurou cotação do item {itemSequence}" | `itemSequence`, `sourceLabel`, `reasonLabel` | `BUDGET_RESTRICTED` se sigiloso |
| `RISK_ADDED` / `RISK_LEVEL_CHANGED` / `RISK_REMOVED` | `RiskCreated` / `RiskAssessed` / `RiskDeleted` | "{actor} registrou o risco {code} ({levelLabel})" | `code`, `title`, `level` | STANDARD |
| `TERM_IMPORTED_FROM_ETP` | `TermImportedFromEtp` | "{actor} importou dados do ETP (v{etpVersion}) para o TR" | `etpVersion`, `sectionsCount` | STANDARD |

- **RN-TML-03** — Idempotência: índice único `(tenant_id, source_event_id, type)`; reprocessamento do mesmo evento não gera entradas duplicadas.
- **RN-TML-04** — Nomes congelados: `actorName`, `actorDepartmentName` e os nomes dentro de `params` refletem o estado no momento do fato; renomeações, inativações ou exclusões posteriores não alteram entradas já gravadas.
- **RN-TML-05** — Visibilidade `BUDGET_RESTRICTED` (POL-09): aplicada quando a entrada revela ou resume valor orçamentário de processo com `isBudgetConfidential = true` (conforme coluna "Visibilidade" da tabela); as demais entradas são `STANDARD`.
- **RN-TML-06** — A timeline não é auditoria (DEC-025): não registra IP, user-agent nem diff antes/depois; não substitui `AuditLog`; escopo restrito aos eventos curados da tabela acima.
- **RN-TML-07** — Evento cujo nome não constar na tabela de mapeamento é ignorado pelo projetor (não é condição de erro).
- **RN-TML-08** — `entityType`, `entityId` e `movementId` são preenchidos quando o evento referenciar uma entidade ou tramitação específica, conforme seu payload.

## Campos
Não há formulário de usuário; os campos abaixo são os gravados pelo projetor em `ProcessTimelineEntry` (entities.md §4.10):

| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| — | `processId` | uuid | Sim | processo do evento de origem | payload do evento |
| — | `occurredAt` | timestamptz | Sim | data/hora do fato (não da gravação) | payload do evento |
| — | `type` | varchar(60) | Sim | um dos valores de `TimelineEntryType` (tabela da RN-TML-02) | mapeamento |
| — | `actorType` | `ActorType` | Sim | `USER`, `SYSTEM`, `PLATFORM_OPERATOR` ou `INTEGRATION` | payload do evento |
| — | `actorId` | uuid | Não | nulo quando `actorType = SYSTEM` | payload do evento |
| — | `actorName`, `actorDepartmentName` | varchar(200) | Não | congelados no momento do fato (RN-TML-04) | leitura auxiliar na projeção |
| — | `entityType`, `entityId` | varchar(40) / uuid | Não | entidade referenciada pelo evento | payload do evento (RN-TML-08) |
| — | `movementId` | uuid | Não | preenchido quando associado a uma tramitação | payload do evento (RN-TML-08) |
| — | `params` | jsonb | Sim | conforme coluna "params principais" (RN-TML-02) | mapeamento |
| — | `visibility` | `TimelineVisibility` | Sim | `STANDARD` ou `BUDGET_RESTRICTED` | mapeamento (RN-TML-05) |
| — | `sourceEventId` | uuid | Sim | `eventId` do evento de origem | payload do evento (RN-TML-03) |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Payload do evento sem os campos exigidos pelo mapeamento | Backend (projetor) | — (interno; reverte a transação de origem) | `INTERNAL_ERROR` |
| V-02 | Evento com `type` sem mapeamento registrado | Backend (projetor) | — (sem impacto para o usuário; log `debug`) | — |
| V-03 | `processId` do evento fora do tenant do contexto (`app.tenant_id`) | Backend (RLS) | — (bloqueado pelo banco) | — |

## Permissões
- **Permissão:** nenhuma — execução interna, síncrona, disparada por casos de uso de domínio; não é endpoint de API nem ação direta do usuário.
- **Políticas:** POL-09 determina a `visibility` gravada na entrada; a aplicação da política na leitura (ocultar `BUDGET_RESTRICTED`) é responsabilidade da US-060.
- **MFA:** não aplicável.
- **Sem permissão:** não aplicável; se o caso de uso de origem for bloqueado por falta de permissão (ex.: `PERMISSION_DENIED` em `PROCESS_CREATE`), o evento nunca é publicado e, portanto, nenhuma entrada é projetada.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| — | — | — | Este caso de uso não publica eventos; consome os eventos listados na RN-TML-02 para gravar `ProcessTimelineEntry`. Não há escrita em `outbox_events`. |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | — | — | Nenhuma. Notificações são derivadas dos mesmos eventos por um consumidor assíncrono próprio (events.md §6), fora do escopo desta story. |

## Critérios de aceite em Gherkin
```gherkin
Feature: Projetar eventos do processo na timeline

  Background:
    Given que o tenant "Prefeitura de São José" está ativo
    And existe o processo "0012/2026" sob custódia do "Setor de Manutenção"

  Scenario: [Sucesso] Projetar a criação do processo
    When o caso de uso "CreateProcessHandler" publicar o evento "ProcessCreated" para o processo "0012/2026"
    Then deve ser gravada, na mesma transação, uma entrada de timeline do tipo "PROCESS_CREATED"
    And a entrada deve conter os parâmetros "code", "title" e "requestingDepartmentName" congelados no momento do fato
    And a visibilidade da entrada deve ser "STANDARD"

  Scenario: [Sucesso] Projetar atualização de campo orçamentário sigiloso
    Given que o processo "0012/2026" tem "isBudgetConfidential" igual a verdadeiro
    When o evento "ProcessUpdated" alterar o campo "estimatedValue"
    Then deve ser gravada uma entrada do tipo "PROCESS_UPDATED" com visibilidade "BUDGET_RESTRICTED"

  Scenario: [Validação] Evento sem mapeamento registrado é ignorado
    When for publicado um evento de domínio cujo nome não constar no registro "TimelineEntryType"
    Then nenhuma entrada de timeline deve ser gravada
    And deve ser registrado log "debug" "timeline.event_not_mapped" sem interromper a transação de origem

  Scenario: [Permissão] Ação de origem sem permissão não gera projeção
    Given que o usuário "Bruno" não possui "PROCESS_CREATE"
    When "Bruno" tentar criar um processo e a API responder 403 "PERMISSION_DENIED"
    Then nenhum evento "ProcessCreated" deve ser publicado
    And nenhuma entrada de timeline deve ser gravada para essa tentativa

  Scenario: [Tenant incorreto] Isolamento entre tenants
    Given que existe o processo "0007/2026" no tenant "Prefeitura B"
    When um evento do processo "0007/2026" for projetado
    Then a entrada de timeline deve ser gravada com o "tenantId" da "Prefeitura B"
    And uma consulta com "app.tenant_id" da "Prefeitura de São José" não deve retornar essa entrada (RLS)

  Scenario: [Duplicidade] Reprocessamento do mesmo evento não duplica a entrada
    Given que o evento "ProcessCreated" de id "E1" já gerou a entrada "PROCESS_CREATED" do processo "0012/2026"
    When o evento "E1" for reprocessado (replay manual de backfill)
    Then nenhuma nova entrada deve ser criada
    And deve continuar existindo exatamente uma entrada com "sourceEventId" igual a "E1" e "type" "PROCESS_CREATED"

  Scenario: [Concorrência] Dois eventos distintos do mesmo processo em paralelo
    Given que o processo "0012/2026" recebe simultaneamente os eventos "ProcessItemsChanged" e "CommentCreated"
    When ambos forem projetados
    Then devem existir duas entradas de timeline distintas, uma do tipo "ITEMS_CHANGED" e outra do tipo "COMMENT_ADDED"
    And a ordenação por "occurredAt" e "id" deve refletir a ordem de ocorrência

  Scenario: [Falha de banco] Banco indisponível durante a transação de origem
    Given que o banco de dados fica indisponível durante a transação que gera o evento "ProcessStageChanged"
    When a transação falhar
    Then nenhuma mudança de etapa, evento ou entrada de timeline deve ser persistida
    And a API de origem deve responder 503 com código "DEPENDENCY_UNAVAILABLE"

  Scenario: [Falha de integração] Fila "domain-events" indisponível não impede a timeline
    Given que o relay do outbox e a fila "domain-events" estão indisponíveis
    When um processo válido for criado
    Then a entrada de timeline "PROCESS_CREATED" deve ser gravada normalmente, pois o projetor é síncrono in-process (DEC-161)
    And o evento "ProcessCreated" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Evento sem mapeamento registrado | — | — | — (sem mensagem; log interno) | Nenhum; projeção ignorada, caso de uso de origem segue normalmente |
| Falha ao gravar a entrada dentro da transação de origem | conforme caso de uso de origem | `INTERNAL_ERROR` | Mensagem do caso de uso de origem | Transação de origem é revertida por completo |
| Banco indisponível durante a transação de origem | 503 | `DEPENDENCY_UNAVAILABLE` | Mensagem do caso de uso de origem | Mantém dados do formulário de origem; botão "Tentar novamente" |

## Dependências
- **Stories:** US-082 (outbox — fornece o envelope do evento e a garantia de escrita transacional consumida por este projetor).
- **Decisões/ADRs:** DEC-025 (timeline × auditoria), DEC-161 (entrega de eventos e handlers síncronos), DEC-003 (datas/fuso), DEC-001 (nomenclatura).
- **Configurações:** nenhuma.
- **Lacunas nas fontes canônicas:** nenhuma (confirmado por busca em entities.md e events.md: os nomes de evento, a tabela de mapeamento e os campos de `ProcessTimelineEntry` usados aqui já existem nas fontes canônicas).

## Impacto técnico
- Estabelece o contrato compartilhado `TimelineProjector` (`project(event): Promise<void>`), chamado dentro da transação por qualquer módulo que publique um evento mapeado — padrão análogo ao `TransactionalCommandHandler` de US-001, mas na direção inversa (US-001 depende desta story).
- A tabela de mapeamento (RN-TML-02) vive em código/configuração (`packages/types`, registro `TimelineEntryType`), não em migração de banco — novos tipos podem ser adicionados sem migração, conforme o marcador *(registro)* de entities.md §2.
- Escrita síncrona adiciona um único `INSERT` a cada transação hospedeira; deve permanecer leve (sem joins custosos) para não comprometer o p95 das transações de origem (ex.: < 600 ms em US-001).
- Congelamento de nomes exige leituras auxiliares mínimas (nome do ator, da unidade, do documento); sempre que possível, reaproveitar dados já carregados pelo caso de uso hospedeiro em vez de nova consulta.

## Backend
- **Módulo(s):** `timeline` (dono); chamado por `process`, `document`, `approval`, `comment`, `attachment`, `risk-map`, `price-research` e `term` — todos os módulos que publicam eventos mapeados na RN-TML-02.
- **Casos de uso:** não há `Command`/`Query` própria exposta; a classe de aplicação é o serviço `TimelineProjector` (porta `ITimelineProjector.project(event)`), chamado pelos handlers de cada módulo dentro da transação.
- **Domínio:** `ProcessTimelineEntry` (projeção de leitura, imutável); `TimelineEntryType` (registro em `packages/types`); `TimelineEntryMapper` (estratégia por tipo de evento, com discriminador quando necessário, ex.: `MovementAction`).
- **Integrações internas:** `platform` (payload do evento conforme DEC-160); `access` (nomes de ator/unidade quando não vierem completos no payload); `catalog` (rótulos de catálogo quando exigidos por `params`).
- **Transação:** a projeção ocorre dentro da transação do caso de uso de origem (DEC-161); não abre transação própria; grava com `ON CONFLICT (tenant_id, source_event_id, type) DO NOTHING`.

## Frontend
- **Tela(s):** nenhuma — story backend sem interface própria; o resultado é consumido pela aba "Timeline" de SCR-006 em US-060.
- **Componentes:** não aplicável.
- **Estados:** não aplicável.
- **Acessibilidade e responsividade:** não aplicável.

## Banco de dados
- **Tabelas:** `process_timeline_entries` (escrita); leituras auxiliares eventuais em `users`/`departments` para nomes congelados.
- **Migrações:** criação de `process_timeline_entries` conforme entities.md §4.10 (colunas, RLS `ENABLE`+`FORCE`, trigger de imutabilidade — sem `updatedAt`/`version`).
- **Índices/constraints relevantes:** `UNIQUE (tenant_id, source_event_id, type)` (idempotência, RN-TML-03); índice `(tenant_id, process_id, occurred_at DESC, id DESC)` para suportar a leitura paginada de US-060.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| — | — | — | Nenhum endpoint de API nesta story (ver `PRC-12` em US-060) | — | — |

## Logs
- `info` `timeline.entry_projected` — `processId`, `type`, `sourceEventId`, `durationMs`.
- `debug` `timeline.event_not_mapped` — `eventType`.
- `warn` `timeline.duplicate_ignored` — `sourceEventId`, `type` (quando o conflito de unicidade for de fato acionado, ex.: reprocessamento).
- `error` `timeline.projection_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** valores orçamentários sigilosos, conteúdo de comentários, demais dados sensíveis de `params`.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| — | — | — | Esta projeção não gera registro de auditoria próprio (DEC-025); a auditoria da ação de origem é responsabilidade do caso de uso que publicou o evento (ex.: `process.create` em US-001). |

## Testes necessários
- **Unitários:** mapeamento de cada evento → `TimelineEntryType` (tabela completa da RN-TML-02); resolução de `visibility` (POL-09); congelamento de nomes.
- **Integração (Testcontainers):** escrita na mesma transação do caso de uso hospedeiro; idempotência via constraint única; rollback conjunto em falha simulada.
- **API/contrato:** não aplicável (sem endpoint próprio); cobertura indireta via contrato de `PRC-12` (US-060).
- **RBAC e multi-tenant:** isolamento por RLS entre tenants, tanto na escrita quanto nas leituras auxiliares.
- **Concorrência:** duas transações concorrentes gerando eventos distintos do mesmo processo não colidem; mesma chave (`sourceEventId`, `type`) sob concorrência grava uma única vez.
- **E2E (Playwright):** indireta, validada pela jornada de criação de processo (US-001) observando a entrada resultante na timeline (US-060).
- **Acessibilidade/performance:** p95 do `INSERT` da projeção < 20 ms; não deve degradar o p95 das transações hospedeiras.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando
- [ ] Mapeamento `TimelineEntryType` implementado e testado para os pares evento→tipo da RN-TML-02
- [ ] Escrita comprovadamente síncrona e transacional (teste de falha induzida reverte a timeline junto)
- [ ] Idempotência comprovada por teste de reprocessamento do mesmo `eventId`
- [ ] Teste de isolamento de tenant incluído na suíte "tenant leak"
- [ ] Migração de `process_timeline_entries` aplicada (RLS, índices, unicidade)
- [ ] Logs sem dados sensíveis; métricas `timeline_entries_projected_total` e latência
- [ ] Revisão de código e de segurança aprovadas
- [ ] Documentação (este card e fontes canônicas) atualizada

## Estimativa
**M** — mapeamento abrangente (todos os pares evento→tipo da RN-TML-02), porém mecanicamente simples (sem UI, sem fluxo multi-etapas); a complexidade está em manter a tabela completa e garantir a idempotência, não em regras de negócio profundas.

## Prioridade
**P0** — pré-requisito transversal: stories de outros módulos (ex.: US-001) já declaram esta story como dependência para considerar sua própria narrativa de processo completa.
