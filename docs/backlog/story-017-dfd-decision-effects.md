---
id: US-017
title: "Tratar decisão sobre o DFD e propagar dados ao processo"
epic: EP-002
feature: FT-009
mvp: 1
priority: P0
estimate: M
status: Especificada
depends_on: [US-016, US-052]
modules: [dfd, document, process, approval, timeline, audit, notification, platform]
screens: [SCR-007, SCR-006]
endpoints: [DFD-03, DOC-12]
permissions: [PROCESS_VIEW, DOCUMENT_REOPEN]
events: [DocumentApproved, DocumentReturned, DocumentRejected, ProcessStatusChanged, ProcessItemsChanged]
---

# US-017 — Tratar decisão sobre o DFD e propagar dados ao processo

## Título
Tratar decisão sobre o DFD e propagar dados ao processo

## Descrição
**Como** sistema, **quero** aplicar os efeitos da decisão tomada sobre o DFD em aprovação, **para** que aprovar, devolver ou indeferir a demanda produza automaticamente o estado correto do documento e do processo, sem exigir um passo manual adicional do aprovador ou da requisitante.

Esta story cobre o que acontece **depois** que o titular decide a aprovação `APROVACAO_DFD` que cobre o DFD (US-052): quando `APPROVED`, propaga ao processo os dados que só existiam no DFD — valor estimado, quantidade de referência dos itens, situação no PCA e prioridade; quando `RETURNED` ou `REJECTED`, garante que o DFD e o processo fiquem no estado certo para a requisitante corrigir e reabrir (DOC-12). A decisão em si (criar o registro de `Approval` e transicionar o documento conforme DEC-018) é de US-052; aqui tratamos o efeito **específico do DFD**.

## Contexto
- DEC-032 define a precedência de `Process.estimatedValue` (TR > pesquisa > ETP > DFD > manual); até esta story, nenhuma fonte alimentava o processo a partir do DFD.
- DEC-019 separa a identidade do item (`ProcessItem`) da quantidade declarada em cada documento (`DocumentItem`); `referenceQuantity` só é atualizado quando um documento com itens é aprovado.
- DEC-029 mantém a referência ao PCA tanto no `Process` quanto no `Dfd`; a aprovação do DFD é o primeiro momento em que a situação do PCA é confirmada formalmente.
- Quando o workflow do processo não tiver etapa de aprovação cobrindo o DFD, a finalização (DOC-10) já propaga esses dados sozinha (RN-DFD-61, US-065); esta story cobre o caminho padrão, em que `APROVACAO_DFD` decide o destino do DFD.

## Objetivo
Garantir que 100% das decisões sobre o DFD produzam, na mesma transação, o estado correto do documento, do processo e dos itens — sem nenhuma ação manual de propagação pela requisitante ou pelo aprovador.

## Persona
- **Principal:** Sistema (reação à decisão de US-052).
- **Secundárias:** Titular da secretaria (`DEPARTMENT_HEAD`, aprovador), servidora da área requisitante (vê o resultado e, se necessário, reabre).

## Pré-condições
- Existe `Approval` `PENDING` cujo `subjectType = PROCESS_STAGE` cobre `DFD` (`ApprovalDocument`) e o DFD está `IN_REVIEW` ou `FINALIZED` com `pendingApprovalId` preenchido (US-016).
- O titular decidiu a aprovação (`APPROVE`, `RETURN` ou `REJECT`) via US-052.

## Fluxo principal
1. US-052 valida a decisão, grava `Approval.status`, transiciona o `Dfd`/`Document` conforme DEC-018 e, antes de confirmar, chama o efeito específico do tipo `DFD` **na mesma transação**.
2. Decisão `APPROVED`: o sistema aplica RN-DFD-63 a RN-DFD-66 (valor, quantidades, PCA, prioridade) e grava a auditoria de cada campo alterado.
3. Decisão `RETURNED` ou `REJECTED`: o sistema não propaga valores; guarda o motivo informado pelo aprovador (campo de comentário da decisão, US-052) para exibição na tela do DFD e, se `REJECTED`, marca o processo para exibir a sugestão de cancelamento (PEND-02).
4. A transição de `Process.status`/etapa (DEC-013, genérica) e a transição do `Document` (DEC-018, genérica) são confirmadas junto com os efeitos específicos do DFD.
5. No commit, são publicados os eventos de documento (`DFDApproved`/`DocumentReturned`/`DocumentRejected`) e, se algo no processo mudou, `ProcessStatusChanged`/`ProcessItemsChanged`.
6. SCR-007 e SCR-006 exibem o resultado: selo de decisão, valores propagados (com a origem `DFD` quando aplicável) e, se devolvido/indeferido, o botão **"Reabrir DFD"** (DOC-12) para quem detém a custódia.

## Fluxos alternativos
- **FA-01 — Reabertura após devolução/indeferimento:** a requisitante aciona **"Reabrir DFD"** (DOC-12, POL-11); o DFD volta a `DRAFT` a partir da última versão, `wizardStep` volta para `REVIEW`; os dados já propagados ao processo em um ciclo anterior não são desfeitos.
- **FA-02 — Orçamento sigiloso:** com `Process.isBudgetConfidential = true`, o valor propagado é gravado normalmente, mas exibido mascarado (POL-09) a quem não tem `PROCESS_VIEW_CONFIDENTIAL_BUDGET`.
- **FA-03 — Processo sem valor de maior precedência:** se já existir `estimatedValueSource` de ETP, pesquisa ou TR, a aprovação do DFD não altera `Process.estimatedValue` (DEC-032); os demais efeitos (quantidade, PCA, prioridade) ocorrem normalmente.

## Regras de negócio
- **RN-DFD-62** — O efeito é aplicado **de forma síncrona, na mesma transação** da decisão (US-052), para `Approval.subjectType = PROCESS_STAGE` cuja etapa cobre o tipo `DFD`; não há consumo assíncrono de evento para este efeito (atomicidade com a decisão).
- **RN-DFD-63** — `APPROVED` e `Dfd.estimatedValue` preenchido: `Process.estimatedValue` só é sobrescrito se `estimatedValueSource` atual for `MANUAL` ou `DFD` (ou nulo); com fonte de maior precedência (`ETP`, `PRICE_RESEARCH`, `TERM`) o valor do processo não muda (DEC-032). Quando sobrescrito, `estimatedValueSource = DFD`.
- **RN-DFD-64** — `APPROVED`: para cada `DocumentItem` do DFD, `ProcessItem.referenceQuantity` recebe a `quantity` do item e `referenceQuantitySourceDocumentId` recebe o `documentId` do DFD (DEC-019); itens do processo sem `DocumentItem` no DFD não são alterados.
- **RN-DFD-65** — `APPROVED`: `Process.pcaStatus`, `pcaYear`, `pcaItemCode` e `pcaJustification` passam a ser os do `Dfd` (primeira confirmação formal da situação do PCA); a alteração é auditada com os valores anterior e novo.
- **RN-DFD-66** — `APPROVED`: `Process.priority` passa a ser `Dfd.priority` (mesma lógica de sincronização do PCA — RN-DFD-65); ajustes posteriores de prioridade seguem US-005.
- **RN-DFD-67** — `RETURNED`: nenhum campo do processo é propagado; `Dfd`/`Document` ficam `RETURNED` (DEC-018) e o processo retorna a `ABERTURA` sob custódia de quem pode reabrir (mecânica genérica de devolução — US-052/US-047).
- **RN-DFD-68** — `REJECTED`: nenhum campo do processo é propagado; `Dfd`/`Document` ficam `REJECTED` (terminal até reabertura — DEC-018); `Process.status` vai a `RETURNED` (DEC-013); a tela do processo exibe a sugestão "Considere cancelar este processo" (PEND-02), sem cancelamento automático.
- **RN-DFD-69** — Reabertura (DOC-12/POL-11) após `RETURNED`/`REJECTED`: `Dfd.wizardStep` volta para `REVIEW`; `completedSteps` é preservado; a nova submissão segue RN-DFD-48 (nova versão e nova `Approval`).
- **RN-DFD-70** — Toda a propagação é idempotente em relação ao comando de decisão: reenviar a mesma decisão com a mesma `Idempotency-Key` (US-052) devolve a mesma resposta e não reaplica os efeitos.
- **RN-DFD-71** — Cada campo propagado gera entrada própria de auditoria, distinta de `approval.decide` (US-052) e de `document.approve`/`document.return`/`document.reject`; não há, nas fontes revisadas, evento de domínio nem ação de auditoria dedicados para essa propagação (ver lacuna).

## Campos
| Campo (destino) | Campo técnico | Tipo | Origem | Regra |
|---|---|---|---|---|
| Valor estimado do processo | `Process.estimatedValue` / `estimatedValueSource` | moeda | `Dfd.estimatedValue` | RN-DFD-63 |
| Quantidade de referência do item | `ProcessItem.referenceQuantity` / `…SourceDocumentId` | numeric(18,4) | `DocumentItem.quantity` | RN-DFD-64 |
| Situação no PCA | `Process.pcaStatus`, `pcaYear`, `pcaItemCode`, `pcaJustification` | — | campos equivalentes do `Dfd` | RN-DFD-65 |
| Prioridade | `Process.priority` | enum | `Dfd.priority` | RN-DFD-66 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | Aprovação não está `PENDING` ou não cobre o DFD | API | — (erro interno de integração, não acionável pelo usuário) | `APPROVAL_NOT_PENDING` |
| V-02 | Reabertura sem `DOCUMENT_REOPEN`/custódia | Front + API | "Você não pode reabrir este DFD." | `PERMISSION_DENIED` |
| V-03 | Reabertura com aprovação `PENDING` ainda em curso | Front + API | "Reabrir DFD" não é oferecido; a API recusa pela regra genérica do DOC-12 (sem custódia → 403 `NOT_PROCESS_CUSTODIAN`; com custódia → 409 `INVALID_PROCESS_STATUS`/`INVALID_STATE`) | — |
| V-04 | Valor propagado exibido a usuário sem POL-09 | API | — (mascarado, sem erro) | — |

## Permissões
- **Permissão:** nenhuma nova; a decisão em si usa as permissões de US-052. A visualização dos efeitos usa `PROCESS_VIEW` (+POL-09 para valores); a reabertura usa `DOCUMENT_REOPEN` + POL-11.
- **Políticas:** POL-09 (orçamento sigiloso), POL-11 (reabrir documento).
- **MFA:** não exigido por esta story (segue a política da ação de decisão, US-052).
- **Sem permissão:** botão "Reabrir DFD" oculto sem `DOCUMENT_REOPEN`/custódia; valores sigilosos seguem mascarados.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DFDApproved` (`DocumentApproved`) | `document.approved.dfd` | Decisão `APPROVED` | Valores propagados vão em metadados de auditoria, não no payload |
| `DocumentReturned` | `document.returned.dfd` | Decisão `RETURNED` | |
| `DocumentRejected` | `document.rejected.dfd` | Decisão `REJECTED` | |
| `ProcessUpdated` | `process.updated` | Propagação em `APPROVED` | `changedFields` (ex.: `estimatedValue`, `pcaStatus`, `priority`) sem valores sigilosos; timeline `PROCESS_UPDATED` |
| `ProcessItemsChanged` | `process.items_changed` | `referenceQuantity` atualizada em `APPROVED` | `updated: id[]`, `itemsCount`; timeline `ITEMS_CHANGED` |
| `ProcessStatusChanged` | `process.status_changed` | Mudança de status do processo (`RETURNED`/`REJECTED`) | Emitido pela mecânica genérica (US-052/DEC-013) |
| `ProcessItemsChanged` | `process.items_changed` | `APPROVED` com itens | Reaproveitado para refletir a atualização de `referenceQuantity` |

Não há evento de domínio dedicado para a atualização de `estimatedValue`/PCA/prioridade do processo (ver lacuna).

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| — | Responsável/custodiante do processo | IN_APP, EMAIL | Reaproveita a notificação da decisão de aprovação (US-052); esta story não cria tipo novo |

## Critérios de aceite em Gherkin
```gherkin
Feature: Tratar decisão sobre o DFD e propagar dados ao processo

  Background:
    Given que o processo "0012/2026" está em "APROVACAO_DFD" com o DFD "DFD 0005/2026" em "IN_REVIEW"
    And existe uma "Approval" pendente cobrindo o DFD

  Scenario: [Sucesso] Decisão APPROVED propaga valor, quantidade, PCA e prioridade
    Given que o DFD tem valor estimado "15000.00", um item com quantidade "10" e situação no PCA "PLANNED"
    And o processo não tem "estimatedValueSource" de ETP, pesquisa ou TR
    When o titular decidir "APPROVE"
    Then o DFD deve ficar "APPROVED"
    And o processo deve receber "estimatedValue" "15000.00" com "estimatedValueSource" "DFD"
    And o item do processo deve receber "referenceQuantity" "10"
    And o processo deve refletir a situação no PCA e a prioridade do DFD
    And devem ser gerados registros de auditoria de propagação do processo e do item
    And deve ser gerado o evento "DFDApproved"

  Scenario: [Sucesso] Decisão REJECTED devolve o processo e sugere cancelamento
    When o titular decidir "REJECT" com o motivo "Demanda já atendida por contrato vigente"
    Then o DFD deve ficar "REJECTED"
    And o processo deve ficar com status "RETURNED" na etapa "ABERTURA"
    And a tela do processo deve exibir a sugestão "Considere cancelar este processo"
    And nenhum valor deve ser propagado ao processo

  Scenario: [Validação] Processo já tem valor de fonte de maior precedência
    Given que o processo tem "estimatedValueSource" "TERM"
    When o titular decidir "APPROVE" para o DFD com valor estimado "9000.00"
    Then o "estimatedValue" do processo não deve ser alterado
    And os demais efeitos (quantidade, PCA, prioridade) devem ser aplicados normalmente

  Scenario: [Permissão] Valor propagado fica mascarado para quem não vê orçamento sigiloso
    Given que o processo tem "isBudgetConfidential" verdadeiro
    And a usuária "Carla" não tem "PROCESS_VIEW_CONFIDENTIAL_BUDGET" nem custódia do processo
    When "Carla" abrir o painel do processo após a decisão "APPROVE"
    Then o campo de valor estimado deve aparecer nulo com "estimatedValueMasked" verdadeiro

  Scenario: [Tenant incorreto] Efeito nunca cruza tenant
    Given que a transação da decisão define "app.tenant_id" do tenant do processo
    When a decisão for processada
    Then nenhuma leitura ou escrita deve ocorrer fora do tenant do processo e do DFD
    And a RLS deve rejeitar qualquer tentativa de acesso a outro tenant

  Scenario: [Duplicidade] Reenvio da decisão não duplica a propagação
    Given que a decisão "APPROVE" já foi processada com a chave de idempotência "K1"
    When a mesma requisição for reenviada com a chave "K1"
    Then a resposta deve ser idêntica com "Idempotent-Replayed: true"
    And o valor do processo e a quantidade de referência não devem ser alterados novamente
    And não deve haver novo registro de auditoria de propagação

  Scenario: [Concorrência] Edição do DFD durante o processamento da decisão
    Given que a decisão "APPROVE" está sendo processada
    When a requisitante tentar salvar uma seção do DFD no mesmo instante
    Then a gravação deve falhar com "INVALID_PROCESS_STATUS"
    And a decisão deve ser concluída sem interferência da tentativa de edição

  Scenario: [Falha de banco] Falha no meio da propagação desfaz a decisão inteira
    Given que o banco de dados falha após atualizar "ProcessItem.referenceQuantity" e antes de confirmar
    When a transação for revertida
    Then o DFD deve permanecer "IN_REVIEW"
    And nenhum campo do processo ou do item deve ter sido alterado
    And a API deve responder 503 com "DEPENDENCY_UNAVAILABLE"

  Scenario: [Falha de integração] Outbox indisponível ao publicar os eventos pós-decisão
    Given que o relay do outbox está indisponível
    When o titular decidir "APPROVE"
    Then o DFD e o processo devem ser atualizados normalmente
    And o evento "DFDApproved" deve permanecer "PENDING" no outbox até o relay voltar
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Aprovação não pendente/não cobre o DFD | 409 | `APPROVAL_NOT_PENDING` | — (erro interno de integração) | Registrado em log; decisão rejeitada |
| Reabertura sem permissão/custódia | 403 | `PERMISSION_DENIED` | "Você não pode reabrir este DFD." | Botão oculto; mensagem se forçado via API |
| Reabertura com aprovação pendente | 403/409 | `NOT_PROCESS_CUSTODIAN` / `INVALID_PROCESS_STATUS` (DOC-12 genérico) | — | Botão oculto (sem `REOPEN` em `meta.allowedActions`) |
| Conflito de edição durante a decisão | 409 | `INVALID_PROCESS_STATUS` | (mensagem genérica do processo em aprovação — US-065) | Recarrega o estado do documento |
| Banco/infra indisponível durante a propagação | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir a decisão agora. Tente novamente." | Mantém "Approval" pendente; botão "Tentar novamente" |

## Dependências
- **Stories:** US-016 (conclusão e envio para aprovação), US-052 (decidir aprovação — dono da transição genérica de `Approval`/`Document`/`Process`), US-065 (ciclo de vida do documento, DOC-12), US-047 (mecânica genérica de devolução de etapa), US-006 (`ProcessItem`), US-073 (auditoria), US-082 (outbox). Indiretas: US-014, US-015, US-005.
- **Decisões/ADRs:** DEC-013, DEC-017, DEC-018, DEC-019, DEC-029, DEC-032; PEND-02.
- **Configurações:** nenhuma chave de tenant específica.
- **Lacunas nas fontes canônicas:**
  1. ~~Evento/auditoria da propagação~~ — resolvido com os canônicos `ProcessUpdated`/`ProcessItemsChanged` e `process.update`/`process.items_update` (`metadata.source = "DFD_APPROVAL"`).
  2. A regra de precedência de `Process.priority` na aprovação do DFD não está documentada (só DEC-032 trata precedência de valor); adotamos sincronização direta análoga à do PCA (RN-DFD-66), a confirmar com produto.
  3. ~~Endpoint da decisão~~ — resolvido: APV-03 `POST /approvals/{id}/decide` (US-052).

## Impacto técnico
- Estabelece o padrão de **"efeito de decisão por tipo de documento"**: US-052 chama um ponto de extensão na mesma transação; esta story implementa a entrada `DFD`. ETP e TR (épicos futuros) deverão reusar o mesmo ponto de extensão.
- Nenhuma migração nova: todos os campos escritos já existem em `Process`, `ProcessItem` e `Dfd`.
- Risco principal: esquecer de checar a precedência (RN-DFD-63) e sobrescrever um valor de fonte melhor — mitigado por teste de integração dedicado.

## Backend
- **Módulo(s):** `dfd` (dono do efeito), chamado por `approval` (US-052); usa `process` (`ProcessRepository`, `ProcessItemRepository`), `audit`, `platform` (outbox).
- **Casos de uso:** `ApplyDfdApprovalEffectsHandler` (chamado internamente por `DecideApprovalHandler` de US-052; sem endpoint HTTP próprio).
- **Domínio:** `Dfd.applyDecisionEffects(decision, ctx)`; `Process.syncFromDfd(dfd)` (aplica RN-DFD-63 a 66, respeitando DEC-032).
- **Transação:** executa dentro da transação de `DecideApprovalHandler` (US-052); qualquer falha desfaz decisão + efeitos.

## Frontend
- **Tela(s):** SCR-007 (banner de decisão e botão "Reabrir DFD"), SCR-006 (painel do processo com os campos propagados e selo de origem "DFD").
- **Componentes:** `DecisionBanner` (aprovado/devolvido/indeferido, com motivo), `CancelSuggestionCallout` (REJECTED), `EstimatedValueBadge` (origem e máscara POL-09).
- **Estados:** carregando o resultado da decisão; erro ao carregar; nenhum formulário novo (esta story não introduz entrada de dados pelo usuário).
- **Acessibilidade e responsividade:** banner e callout anunciados via `aria-live`; mesmo layout responsivo de SCR-007/SCR-006 (US-014/US-004).

## Banco de dados
- **Tabelas:** `processes`, `process_items`, `documents`, `dfds`, `audit_logs`, `outbox_events` (todas já existentes).
- **Migrações:** nenhuma.
- **Índices/constraints relevantes:** reaproveita `UNIQUE (tenant_id, process_id, sequence)` em `process_items` e os índices de `audit_logs` por `(tenant_id, created_at)`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| DFD-03 | GET | `/dfds/{id}` | — | Estado atual do DFD após a decisão (status, propagação refletida no processo) | 200, 403, 404 |
| DOC-12 | POST | `/documents/{id}/reopen` | `{ reason }` + `If-Match` | `200 { data: Document }` em `DRAFT` | 200, 403, 409, 412 |

A decisão é recebida por **APV-03** `POST /approvals/{id}/decide` (contrato de US-052); esta story acrescenta, na mesma transação, o efeito específico do tipo `DFD` e os campos propagados à resposta do processo.

## Logs
- `info` `dfd.approval_effects_applied` — `documentId`, `processId`, `decision`, campos alterados, `durationMs`.
- `info` `dfd.approval_effects_skipped_precedence` — quando `estimatedValue` não é sobrescrito por precedência (RN-DFD-63).
- `error` `dfd.approval_effects_failed` — `errorCode`, `correlationId`.
- **Nunca logar:** valor estimado, justificativa do PCA, motivo da decisão.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `process.update` | `DATA_CHANGE` | Propagação em `APPROVED` | `changes`: `estimatedValue`, `pcaStatus`, `pcaYear`, `pcaItemCode`, `priority` (antes/depois); `metadata.source = "DFD_APPROVAL"`, `decisionApprovalId` |
| `process.items_update` | `DATA_CHANGE` | Itens, em `APPROVED` | `changes.items[].referenceQuantity` (antes/depois); `metadata.source = "DFD_APPROVAL"`, `metadata.sourceDocumentId` |

## Testes necessários
- **Unitários:** `Process.syncFromDfd` (precedência DEC-032; PCA; prioridade); efeitos por decisão (`APPROVED`/`RETURNED`/`REJECTED`).
- **Integração (Testcontainers):** transação única com US-052 (falha simulada não deixa propagação parcial); RLS por tenant.
- **API/contrato:** DFD-03 reflete os campos propagados; DOC-12 reabre corretamente após `RETURNED`/`REJECTED`.
- **Concorrência:** edição simultânea ao processamento da decisão; reenvio com mesma `Idempotency-Key`.
- **E2E (Playwright):** jornada aprovar → ver valores propagados; rejeitar → ver sugestão de cancelamento → reabrir.

## Definition of Done
- [ ] Todos os cenários Gherkin automatizados e passando no CI
- [ ] Precedência de `estimatedValue` (DEC-032) coberta por teste de integração
- [ ] Atomicidade com a decisão de US-052 comprovada por teste de falha induzida
- [ ] Auditoria de propagação do processo e do item verificada em teste
- [ ] Teste de isolamento incluído na suíte "tenant leak"
- [ ] Logs sem dados sensíveis; métricas e trace do efeito de decisão
- [ ] Revisão de código e de segurança aprovadas
- [ ] Lacunas registradas revisadas com produto (prioridade e evento de domínio)

## Estimativa
**M** — lógica de propagação em vários campos com regra de precedência (DEC-032) e necessidade de atomicidade com US-052, mas sem UI nova relevante nem migração.

## Prioridade
**P0** — sem este efeito, a aprovação do DFD não alimenta o processo e a fase preparatória perde o principal ganho de automação do MVP 1.

## Implementação (2026-10-20)
- **Ponto de extensão:** gancho `approvalDecided` do `DocumentValidator` (porta do `document`), chamado pelo dono do sujeito `PROCESS_STAGE` (`ProcessApprovalSubjectHandler.applyDecision`) para cada documento coberto **depois** da mudança de etapa, no `tx` da decisão — a propagação grava sobre a versão que a transição deixou (o `WHERE version` da transição não conflita). ETP/TR reusam o mesmo gancho. A avulsa (`subjectType = DOCUMENT`) não aciona o efeito (RN-DFD-62).
- **DFD:** `ApplyDfdApprovalEffectsHandler` (`dfd`) → `ProcessFacade.applyDfdApprovalIn` (`process`: `syncFromDfd` + `referenceQuantityUpdates`, auditoria `process.update`/`process.items_update` com `metadata.source = DFD_APPROVAL`, `decisionApprovalId`; `ProcessUpdated`/`ProcessItemsChanged`). Valor sigiloso na auditoria = hash + `masked` (como na US-032).
- **RETURNED:** além de não propagar, o wizard do DFD volta a `REVIEW` já na decisão (o DFD devolvido é editável sem reabertura — DEC-018). **REJECTED:** a reabertura (DOC-12, gancho `reopened`) volta o wizard a `REVIEW` (RN-DFD-69).
- **SCR-007:** `meta.decision` no DFD-03 (decisão mais recente, motivo, quem decidiu) → `DecisionBanner` com "Reabrir DFD" quando `REOPEN` está em `meta.allowedActions`. **SCR-006:** `CancelSuggestionCallout` (processo `RETURNED` + DFD `REJECTED`, sem marca persistida) e `EstimatedValueBadge` (valor + origem).
- **Ajustes do Gherkin/erros:** a edição durante a aprovação responde 409 `INVALID_PROCESS_STATUS` (a ordem de checagens da US-065 confere o processo antes do documento — igual à US-016); a reabertura durante a aprovação segue o DOC-12 genérico (sem `APPROVAL_NOT_PENDING` próprio).
- **Lacuna aberta:** a matriz padrão (permissions.md) não dá `DOCUMENT_REOPEN` à `REQUISITANTE`; "a requisitante reabre" (FA-01) depende de o tenant conceder a permissão por perfil.
