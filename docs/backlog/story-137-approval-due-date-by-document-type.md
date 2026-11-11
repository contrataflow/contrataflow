---
id: US-137
title: "Prazo da aprovação avulsa por tipo de documento (DT-17)"
epic: EP-022
feature: FT-067
mvp: 2
priority: P1
estimate: S
status: Especificada
depends_on: [US-051, US-055, US-061]
modules: [approval, document, catalog, audit]
screens: [SCR-013, SCR-014, SCR-015]
endpoints: [DOC-09, CAL-06, DTY-01, DTY-03, APV-01, APV-02, TSK-01]
permissions: [APPROVAL_VIEW, INBOX_VIEW]
events: [ApprovalRequested]
---

# US-137 — Prazo da aprovação avulsa por tipo de documento (DT-17)

## Título
Prazo da aprovação avulsa por tipo de documento (DT-17)

## Descrição
**Como** solicitante que submete um documento para aprovação avulsa (e como aprovador que precisa decidir), **quero** que a aprovação nasça com o prazo definido pelo tipo do documento e que esse prazo apareça na solicitação, na caixa de tarefas, na lista e no detalhe da aprovação, **para** saber até quando a decisão é esperada e para que aprovações avulsas atrasadas deixem de passar em silêncio.

A story paga o débito DT-17 (DEC-209): o campo `DocumentType.approvalPolicy.slaDays` (com `slaType`, `BUSINESS` ou `CALENDAR`) já existe e é editável no MVP 1 (US-061, DTY-03), mas não era usado no caminho da submissão avulsa — a `Approval` nascia com `dueAt` nulo (RN-TRAM-51). Passa a ser usado: na submissão de documento cujo tipo exige aprovação (DOC-09), `Approval.dueAt` é calculado pelo calendário do órgão a partir da solicitação. Não há tabela, coluna nem endpoint novo; a mudança é de comportamento do cálculo e de exibição, com campos aditivos de API (DEC-108).

## Contexto
- Hoje, órgãos cujo regulamento exige aprovação avulsa de um ato (ex.: nota técnica aprovada pela chefia) ligam `requiresApproval` com uma `approvalPolicy` (US-061 · RN-DOC-06) e podem informar o prazo da aprovação, mas o campo é ignorado: a aprovação avulsa não tem prazo, não entra em nenhum alerta e não aparece como atrasada. Os tipos semeados têm `requiresApproval = false` (a aprovação formal acontece nas etapas `APPROVAL` do workflow — DEC-015, DEC-018), de modo que a mudança só alcança tipos que o próprio órgão configurou.
- DEC-209 (DT-17) decide que `Approval.dueAt` nas submissões avulsas sai do prazo configurado no `DocumentType`; a feature FT-067 e o épico EP-022 acrescentam que, em política múltipla (`ALL`/`SEQUENTIAL`), o prazo vale para o conjunto e o prazo por linha só vem com a política de SLA (DEC-193, DEC-205, US-190).
- O prazo da aprovação originada em etapa do workflow (`subjectType = PROCESS_STAGE`) continua igual ao `dueAt` da `ProcessStage` (RN-TRAM-51, primeira parte; DEC-031): esta story só trata `subjectType = DOCUMENT`.
- O cálculo usa o mesmo calendário e a mesma normalização das etapas (RN-TRAM-78 da US-055: fim do dia no fuso do tenant, `Holiday` do tenant, `calendar.optionalHolidaysAreNonBusiness`), por meio de `CAL-06` (US-106).
- US-051 resolve o aprovador e cria a `Approval` dentro da transação de DOC-09 (US-065); esta story acrescenta o passo do prazo a essa mesma transação.

## Objetivo
Garantir que 100% das aprovações avulsas de tipos com `approvalPolicy.slaDays` nasçam com `dueAt` calculado corretamente (dias úteis ou corridos, fim do dia no fuso do tenant), que o prazo seja visível antes de enviar e em toda a leitura da aprovação, e que o comportamento dos tipos sem prazo permaneça idêntico ao do MVP 1.

## Persona
- **Principal:** Solicitante — quem submete o documento (perfis `PLANEJAMENTO`, `REQUISITANTE`, `COMPRAS`, `GESTOR_CONTRATO` etc., conforme a permissão de submissão do tipo).
- **Secundárias:** Aprovador designado (titular de unidade, perfil ou usuário), que vê o prazo na caixa de tarefas e na lista; Administrador do órgão (`ADMIN_ORGAO`), que configura `slaDays` e `slaType` no tipo de documento; Gestor de contratações (`GESTOR_CONTRATACOES`), que acompanha atrasos.

## Pré-condições
- Tipo de documento com `requiresApproval = true` e `approvalPolicy` válida; para haver prazo, `approvalPolicy.slaDays` entre 1 e 365 (validação da US-061, V-11).
- Documento em `DRAFT` ou `RETURNED`, completo (sem violações `BLOCKING`), em processo editável (POL-02) e usuário com a permissão de submissão do tipo.
- Calendário do tenant configurado (feriados nacionais semeados — US-106).

## Fluxo principal
1. O administrador do órgão, em **Configurações › Tipos de documento**, edita o tipo e informa "Prazo da aprovação" (`approvalPolicy.slaDays`) e a contagem (dias úteis ou corridos) — fluxo já existente de DTY-03; a tela ganha o texto de apoio "Vale para as próximas solicitações de aprovação avulsa deste tipo. Aprovações em andamento não mudam."
2. O solicitante abre o documento e aciona **"Enviar para aprovação"**; o diálogo de submissão consulta `CAL-06` com `fromDateTime = agora`, `businessDays = slaDays` e `dayCountType = slaType` (valores lidos de DTY-01) e exibe "Prazo para a decisão: {dia/mês/ano} ({N} dias úteis)". Sem `slaDays` no tipo, exibe "Este tipo de documento não tem prazo de aprovação."
3. O solicitante confirma; o front envia DOC-09 (`If-Match`, `Idempotency-Key`).
4. A API, na transação de DOC-09: valida completude e permissão, cria a nova versão `SUBMISSION`, resolve o aprovador e cria a `Approval` avulsa e os `ApprovalDocument` (US-051) e **calcula `Approval.dueAt`** (RN-APV-77): `CAL-06` com `fromDateTime = requestedAt`, `businessDays = slaDays`, `dayCountType = slaType`, normalizado para `23:59:59.999` no fuso do tenant e gravado em UTC.
5. A API grava auditoria (`document.submit` e `approval.request`, esta com a origem do prazo), publica `ApprovalRequested` (com `dueAt`) e responde 200 com o `Document` e `pendingApprovalDueAt`.
6. O solicitante vê "Aguardando aprovação até {data}" no documento; o aprovador vê o prazo e o selo de atraso na caixa de tarefas (SCR-013, visão "Aprovações pendentes"), na lista (SCR-014, coluna "Prazo") e no detalhe (SCR-015, fato-chave "Prazo").
7. Se o prazo vence com a aprovação ainda `PENDING`, a lista, a caixa e o detalhe passam a exibir "Atrasada" (RN-INBOX-16); a aprovação **não** muda de status nem é decidida pelo sistema (RN-APV-85).
8. O aprovador decide; a aprovação encerra e o selo de prazo deixa de ser exibido como pendente.

## Fluxos alternativos
- **FA-01 — Tipo sem `slaDays`:** `dueAt` fica nulo, a UI não exibe prazo e nada muda em relação ao MVP 1 (RN-APV-78).
- **FA-02 — `slaType` ausente com `slaDays` presente:** a contagem é `BUSINESS`, o padrão do formulário de US-061 (RN-APV-77).
- **FA-03 — Devolução e reenvio:** o aprovador devolve; o solicitante corrige e reenvia; é criada **nova** `Approval` e o prazo é recalculado a partir do novo `requestedAt` (RN-APV-87).
- **FA-04 — Retirada da aprovação (DOC-11):** a `Approval` vai a `CANCELED` e o prazo deixa de valer; uma nova submissão calcula um novo prazo.
- **FA-05 — Prazo do tipo alterado depois da solicitação:** aprovações em andamento mantêm o `dueAt` já gravado; só novas solicitações usam o valor novo (RN-APV-88).
- **FA-06 — Preview diferente do valor gravado:** se o calendário mudar entre o preview e a confirmação (ex.: feriado cadastrado no meio tempo), vale o valor calculado pelo servidor e a resposta traz o `dueAt` final; a UI atualiza a mensagem de confirmação (RN-APV-83).
- **FA-07 — Aprovação com política múltipla (quando o tipo ou a configuração futura definirem várias linhas):** `Approval.dueAt` vale para o conjunto; `ApprovalApprover.dueAt` das linhas fica nulo e herda o da aprovação (RN-APV-81).
- **FA-08 — Processo suspenso:** como no MVP 1 (RN-PROC-98/99), a retomada estende `Approval.dueAt` pelos mesmos `n` dias da pausa da etapa; esta story não altera esse mecanismo.
- **FA-09 — Calendário indisponível:** o cálculo falha, a transação de DOC-09 é desfeita e a submissão responde 503 `DEPENDENCY_UNAVAILABLE`; nunca se cria aprovação sem prazo por causa de falha de calendário (RN-APV-89).

## Regras de negócio
- **RN-APV-77** — Na submissão avulsa (DOC-09) de documento cujo `DocumentType.requiresApproval = true` e cuja `approvalPolicy.slaDays` está preenchida, `Approval.dueAt` = fim do dia (`23:59:59.999`, fuso do tenant, gravado em UTC) do N-ésimo dia a partir de `requestedAt`, com `N = slaDays` e contagem `slaType` (`BUSINESS`, considerando `Holiday` do tenant e `calendar.optionalHolidaysAreNonBusiness`, ou `CALENDAR`); `slaType` ausente equivale a `BUSINESS`. O cálculo usa `CAL-06` por meio de `BusinessCalendarFacade` (mesma regra de RN-TRAM-78) — DEC-209.
- **RN-APV-78** — Sem `approvalPolicy.slaDays`, `dueAt` permanece nulo, como no MVP 1 (RN-TRAM-51, caso `DOCUMENT`); nenhum dado, evento ou tela muda para esses tipos.
- **RN-APV-79** — O cálculo vale apenas para `subjectType = DOCUMENT`. Aprovações de `PROCESS_STAGE` seguem o `dueAt` da `ProcessStage` recém-criada (RN-TRAM-51); aprovações de `PCA` (EP-023) não são tratadas aqui.
- **RN-APV-80** — Não há coluna nova para guardar `slaDays`/`slaType` usados: o valor de `dueAt` gravado é a fonte; a origem do prazo vai na auditoria (`approval.request`, `metadata.dueAtSource = DOCUMENT_TYPE`, `slaDays`, `slaType`) e no evento `ApprovalRequested` (`dueAt`), para rastreio de por que a aprovação tem aquele prazo.
- **RN-APV-81** — Com `decisionPolicy` `ALL` ou `SEQUENTIAL`, `Approval.dueAt` vale para o conjunto das linhas; `ApprovalApprover.dueAt` só é preenchido por política de SLA (`approverDays`, US-190) e, quando nulo, herda `Approval.dueAt` (DEC-193, DEC-205).
- **RN-APV-82** — O calendário é o do tenant (US-106): feriados nacionais semeados, estaduais e municipais cadastrados e pontos facultativos conforme `calendar.optionalHolidaysAreNonBusiness`; feriados de outro tenant nunca entram no cálculo.
- **RN-APV-83** — O diálogo de submissão exibe o prazo previsto calculado por `CAL-06` antes da confirmação, com `fromDateTime = agora`; o valor oficial é sempre o calculado no servidor dentro de DOC-09 e vem na resposta (`pendingApprovalDueAt`). O prazo previsto não é gravado nem reservado.
- **RN-APV-84** — Exibição: caixa de tarefas (visão "Aprovações pendentes"), lista (coluna "Prazo") e detalhe (fato-chave "Prazo") mostram `dueAt` e `isOverdue` (RN-INBOX-16); no detalhe o texto "Prazo definido pelo tipo de documento" aparece quando `subjectType = DOCUMENT` e `dueAt` não é nulo. APV-01 ganha os filtros aditivos `overdue` (booleano — apenas `PENDING` com `dueAt` anterior a agora), `dueFrom` e `dueTo` (data `AAAA-MM-DD` no fuso do tenant, inclusive), aplicados a `Approval.dueAt`.
- **RN-APV-85** — O atraso só sinaliza: a aprovação continua `PENDING` até alguém decidir, retirar ou o processo seguir; o sistema nunca aprova, devolve nem indefere por vencimento de prazo (princípio de que a decisão é sempre humana).
- **RN-APV-86** — Alertas e indicadores: aprovação avulsa `PENDING` com `dueAt` vencido entra nos indicadores de atraso (selo `isOverdue`, ordenação e filtro por prazo, e leitura de `Approval.dueAt` pelo read model do EP-028). Esta story **não** cria evento nem tipo de notificação de prazo de aprovação avulsa (ver lacuna 1 em "Dependências").
- **RN-APV-87** — Reenvio após devolução cria nova `Approval` e recalcula o prazo a partir do novo `requestedAt`; retirada e novo envio idem. Redirecionamento do aprovador (US-135) preserva o `dueAt` (RN-TRAM-70).
- **RN-APV-88** — Alterar `approvalPolicy.slaDays` ou `slaType` do tipo vale para solicitações futuras; nunca altera aprovações em andamento, versões nem números emitidos (RN-DOC-08).
- **RN-APV-89** — O cálculo ocorre dentro da transação de DOC-09: falha do calendário ou do banco desfaz a submissão inteira (documento volta ao status anterior, nenhuma `Approval` nem `ApprovalDocument` fica gravada) e responde 503 `DEPENDENCY_UNAVAILABLE`.
- **RN-APV-90** — Compatibilidade (DEC-108): o único campo novo de contrato é `pendingApprovalDueAt` (nulo sem prazo) na resposta de DOC-09 e nas listagens de documento que já trazem `pendingApprovalId`; `ApprovalRequested.dueAt` já existia como opcional; filtros novos de APV-01 são opcionais; nenhum cliente do MVP 1 quebra.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Prazo da aprovação (administração) | `approvalPolicy.slaDays` | inteiro | Não | 1–365 (US-061 · V-11) | — |
| Contagem do prazo (administração) | `approvalPolicy.slaType` | `DayCountType` | Não | `BUSINESS` \| `CALENDAR` | `BUSINESS` |
| Prazo previsto (diálogo de submissão) | `dueDateTime` (resposta de `CAL-06`) | datetime (somente leitura) | — | RN-APV-83 | calculado a partir de agora |
| *(saída)* Prazo da aprovação | `Approval.dueAt` / `pendingApprovalDueAt` | datetime \| nulo | — | RN-APV-77/78 | calculado em DOC-09 |
| *(saída)* Em atraso | `isOverdue` | booleano | — | `PENDING` e `dueAt` < agora (RN-INBOX-16) | derivado |
| Atrasadas (filtro de SCR-014) | `overdue` (query APV-01) | booleano | Não | só `PENDING` | — |
| Prazo de / até (filtro de SCR-014) | `dueFrom`, `dueTo` (query APV-01) | data | Não | `dueFrom` ≤ `dueTo` | — |
| *(auditoria)* Origem do prazo | `metadata.dueAtSource`, `slaDays`, `slaType` | texto / inteiro | — | RN-APV-80 | DOC-09 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `slaDays` fora de 1–365 ao salvar o tipo (DTY-03, regra existente) | Front + API | "O prazo deve estar entre 1 e 365 dias." | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |
| V-02 | `dueFrom` posterior a `dueTo` | Front + API | "O período informado é inválido." | `VALIDATION_ERROR` |
| V-03 | `overdue` não booleano | API (Zod) | — | `VALIDATION_ERROR` (`INVALID_TYPE`) |
| V-04 | Documento incompleto (pendência `BLOCKING`) na submissão | API | "Resolva as pendências do documento antes de enviar." | `DOCUMENT_INCOMPLETE` |
| V-05 | Aprovador não resolvível (US-051) | API | "Não foi possível identificar quem deve aprovar este documento. Avise o administrador do órgão." | `APPROVER_UNRESOLVED` |
| V-06 | Calendário ou banco indisponível durante o cálculo | API | "Não foi possível enviar o documento agora. Tente novamente em instantes." | `DEPENDENCY_UNAVAILABLE` |
| V-07 | Parâmetros de `CAL-06` inválidos no preview (`businessDays` fora do intervalo) | API | — (a UI não mostra prazo previsto) | `VALIDATION_ERROR` (`OUT_OF_RANGE`) |

## Permissões
- **Permissão:** `APPROVAL_VIEW` (ou designação, solicitante, decisor) para ver o prazo em APV-01/APV-02; `INBOX_VIEW` para a caixa de tarefas. Submeter segue a **permissão de submissão do tipo** + POL-02 (DOC-09, sem alteração); configurar `slaDays`/`slaType` segue a administração de tipos de documento do MVP 1 (US-061, DTY-03).
- **Políticas:** POL-02 (submissão), POL-03 (cobertura de aprovador na lista), DEC-024 (visibilidade).
- **MFA:** não exigido (permissões de risco `L`/`M`, salvo `security.mfaPolicy = ALL`).
- **Sem permissão:** o botão "Enviar para aprovação" segue as regras do documento; sem `APPROVAL_VIEW` e sem designação, APV-02 responde 403 `PERMISSION_DENIED` (como no MVP 1); o prazo previsto no diálogo só é exibido a quem pode submeter.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `ApprovalRequested` | `approval.requested` | Commit de DOC-09 que criou a `Approval` avulsa | Já existia; passa a carregar `dueAt` quando calculado (campo opcional do MVP 1). Sem novo evento. Projeta `APPROVAL_REQUESTED` na timeline ("Aprovação solicitada a {approverLabel}", com `dueAt`) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `APPROVAL_REQUESTED` *(MVP 1)* | Aprovador designado (titular e substituto se `allowDeputy`) | in-app (obrigatória) + e-mail | `ApprovalRequested`; passa a citar o prazo quando `dueAt` existe |
| — | — | — | Nenhuma notificação de prazo próximo ou vencido para aprovação avulsa nesta story (ver lacuna 1) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Prazo da aprovação avulsa por tipo de documento

  Background:
    Given que o tenant "Prefeitura A" está ativo
    And o tipo de documento "NOTA_TECNICA" exige aprovação avulsa com aprovador "DEPARTMENT_HEAD" da secretaria solicitante
    And o tipo "NOTA_TECNICA" tem "approvalPolicy.slaDays" 5 e "slaType" "BUSINESS"
    And o calendário da "Prefeitura A" tem o feriado "Consciência Negra" em 20/11/2026
    And "Carla Mendes" tem vínculo ativo, a permissão de submissão do tipo e custódia do processo "0021/2026"
    And "Marcos Lima" é titular da "Secretaria de Administração", unidade solicitante do processo
    And o documento "NT 0003/2026" está em "DRAFT" e completo

  Scenario: [Sucesso] Submissão avulsa recebe o prazo do tipo em dias úteis
    Given que hoje é segunda-feira 16/11/2026 às 10:00
    When "Carla Mendes" abrir o diálogo "Enviar para aprovação"
    Then o diálogo deve exibir "Prazo para a decisão: 24/11/2026 (5 dias úteis)"
    When "Carla Mendes" confirmar o envio
    Then a API deve responder 200 com "pendingApprovalDueAt" igual a "2026-11-25T02:59:59.999Z" (24/11/2026 23:59:59.999 no fuso do tenant)
    And a aprovação deve ter "dueAt" igual a esse valor, pulando o feriado de 20/11
    And deve gerar registro de auditoria "approval.request" com "dueAtSource" "DOCUMENT_TYPE", "slaDays" 5 e "slaType" "BUSINESS"
    And deve gerar o evento "ApprovalRequested" com "dueAt" preenchido
    And a caixa de tarefas de "Marcos Lima" e a lista de aprovações devem exibir o prazo 24/11/2026

  Scenario: [Sucesso] Contagem em dias corridos
    Given que "Marina Costa", administradora, alterou o tipo "NOTA_TECNICA" para "slaDays" 10 e "slaType" "CALENDAR", com auditoria "document_type.update"
    And hoje é segunda-feira 16/11/2026
    When "Carla Mendes" enviar o documento para aprovação
    Then a aprovação deve ter "dueAt" em 26/11/2026 às 23:59:59.999 no fuso do tenant
    And deve gerar o evento "ApprovalRequested" com "dueAt" preenchido

  Scenario: [Sucesso] Tipo sem prazo mantém o comportamento do MVP 1
    Given que o tipo "NOTA_TECNICA" não tem "slaDays"
    When "Carla Mendes" enviar o documento para aprovação
    Then a aprovação deve ser criada sem "dueAt" e "pendingApprovalDueAt" deve ser nulo
    And o diálogo deve ter exibido "Este tipo de documento não tem prazo de aprovação."
    And deve gerar registro de auditoria "approval.request" sem "dueAtSource" e o evento "ApprovalRequested" sem "dueAt"

  Scenario: [Sucesso] Reenvio após devolução recalcula o prazo
    Given que "Marcos Lima" devolveu a aprovação em 25/11/2026
    When "Carla Mendes" reenviar o documento corrigido na sexta-feira 27/11/2026
    Then deve existir uma nova aprovação com "dueAt" em 04/12/2026 às 23:59:59.999
    And a aprovação devolvida deve manter o seu "dueAt" original
    And deve gerar o evento "ApprovalRequested" para a nova aprovação

  Scenario: [Sucesso] Atraso é sinalizado sem decidir a aprovação
    Given que a aprovação do documento "NT 0003/2026" está "PENDING" com "dueAt" em 24/11/2026
    When for 26/11/2026 e "Marcos Lima" abrir "Aprovações" com "overdue" igual a true
    Then a aprovação deve aparecer com o selo "Atrasada"
    And o "status" da aprovação deve continuar "PENDING"
    And nenhuma auditoria nem evento deve ser gerado pela consulta

  Scenario: [Validação] Filtros de prazo e prazo do tipo fora do intervalo
    When "Marcos Lima" chamar "GET /approvals?dueFrom=2026-12-10&dueTo=2026-12-01"
    Then a API deve responder 422 com código "VALIDATION_ERROR" e mensagem "O período informado é inválido."
    When "Marina Costa", administradora, salvar o tipo "NOTA_TECNICA" com "slaDays" 400
    Then a API deve responder 422 com código "VALIDATION_ERROR" e erro "OUT_OF_RANGE" no campo "approvalPolicy.slaDays"

  Scenario: [Permissão] Submissão sem permissão e leitura sem acesso
    Given que "Bruno Lopes" não tem a permissão de submissão do tipo "NOTA_TECNICA"
    When "Bruno Lopes" chamar "POST /documents/{id}/submit"
    Then a API deve responder 403 com código "PERMISSION_DENIED"
    And nenhuma aprovação deve ser criada
    And deve gerar registro de auditoria "access.denied"
    Given que "Bruno Lopes" não tem "APPROVAL_VIEW", não é solicitante nem aprovador da aprovação
    When "Bruno Lopes" chamar "GET /approvals/{id}"
    Then a API deve responder 403 com código "PERMISSION_DENIED"

  Scenario: [Tenant incorreto] Calendário e tipo de outro tenant não influenciam
    Given que o tenant "Prefeitura B" tem o feriado local em 18/11/2026 e um tipo "NOTA_TECNICA" com "slaDays" 3
    When "Carla Mendes" enviar o documento da "Prefeitura A" na segunda-feira 16/11/2026
    Then o "dueAt" deve ser 24/11/2026 às 23:59:59.999, sem considerar o feriado nem o prazo da "Prefeitura B"
    When "Carla Mendes" chamar "GET /approvals/{id-da-aprovação-da-Prefeitura-B}"
    Then a API deve responder 404 com código "APPROVAL_NOT_FOUND"

  Scenario: [Duplicidade] Reenvio da mesma submissão com a mesma chave de idempotência
    Given que "Carla Mendes" enviou o documento com a chave "K1" e recebeu 200 com "pendingApprovalDueAt" "2026-11-25T02:59:59.999Z"
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo "pendingApprovalDueAt" e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única aprovação "PENDING" para o documento e um único evento "ApprovalRequested"

  Scenario: [Concorrência] Duas submissões simultâneas do mesmo documento
    When "Carla Mendes" e "Pedro Alves", ambos com permissão de submissão, enviarem "NT 0003/2026" ao mesmo tempo
    Then exatamente uma submissão deve responder 200 com a aprovação e o "dueAt" calculado
    And a outra deve responder 409 com código "APPROVAL_NOT_PENDING" ou "INVALID_STATE"
    And o "dueAt" da aprovação criada não deve ser alterado pela segunda tentativa

  Scenario: [Falha de banco] Falha ao gravar a aprovação com o prazo
    Given que o banco de dados fica indisponível durante a transação de "POST /documents/{id}/submit"
    When "Carla Mendes" confirmar o envio
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And o documento deve continuar "DRAFT" e nenhuma aprovação, versão, auditoria ou evento deve ter sido gravado

  Scenario: [Falha de integração] Redis indisponível no armazenamento de idempotência
    Given que o Redis está indisponível
    When "Carla Mendes" enviar o documento para aprovação
    Then a API deve responder 200 com o "dueAt" calculado sem consultar o cache de idempotência
    And deve ser registrado log "warn" "idempotency.store_unavailable"
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Documento incompleto | 422 | `DOCUMENT_INCOMPLETE` | "Resolva as pendências do documento antes de enviar." | Lista as violações com link para a seção |
| Aprovador não resolvível | 422 | `APPROVER_UNRESOLVED` | "Não foi possível identificar quem deve aprovar este documento. Avise o administrador do órgão." | Mantém o diálogo e orienta o contato |
| Sem permissão de submissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para enviar este documento." | Oculta/desabilita "Enviar para aprovação" |
| Documento inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Documento não encontrado." | Volta à lista de documentos |
| Status incompatível ou aprovação pendente já existente | 409 | `INVALID_STATE` / `APPROVAL_NOT_PENDING` | "Este documento já foi enviado para aprovação." | Recarrega o documento |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "O documento foi alterado desde que você o revisou. Recarregue e envie de novo." | Recarrega |
| Filtro de prazo inválido | 422 | `VALIDATION_ERROR` | "O período informado é inválido." | Marca o filtro |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Aprovação inexistente ou de outro tenant | 404 | `APPROVAL_NOT_FOUND` | "Aprovação não encontrada." | Volta à lista |
| Banco ou calendário indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível enviar o documento agora. Tente novamente em instantes." | Botão "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-051 (criação da `Approval` e resolução do aprovador — passo do prazo é acrescentado à mesma transação), US-055 (cálculo de prazos em dias úteis e normalização de fim do dia), US-061 (tipos de documento — `approvalPolicy.slaDays`/`slaType`). Indiretas: US-065 (DOC-09), US-106 (`CAL-06`, feriados), US-057 e US-056 (lista e caixa onde o prazo aparece), US-136 (linhas de aprovação — prazo da linha herda o do conjunto), US-190 (prazo por linha por política de SLA), US-135 (redirecionamento preserva `dueAt`).
- **Decisões/ADRs:** DEC-209 (DT-17), DEC-031, DEC-193, DEC-205, DEC-108; RN-DOC-08.
- **Configurações:** `calendar.optionalHolidaysAreNonBusiness`; `approvalPolicy.slaDays`/`slaType` do `DocumentType` (campo existente).
- **Lacunas nas fontes canônicas:**
  1. **Alerta de aprovação avulsa vencida:** a feature diz que o prazo alimenta "os alertas de atraso", mas `events.md` só prevê `ProcessStageDueSoon`/`ProcessStageOverdue` (de `ProcessStage`, sem equivalente para `Approval`) e não há `NotificationType` de prazo de aprovação (só a nota de §6: "Aprovação por linha: com `ApprovalApprover.dueAt`, os avisos de prazo de aprovação usam o prazo da linha"). Proposta: eventos `ApprovalDueSoon`/`ApprovalOverdue` (job `deadlines`, módulo `approval`) e tipos `APPROVAL_DUE_SOON`/`APPROVAL_OVERDUE` em `events.md §3/§4/§6`. Até a decisão, o atraso é só sinalizado (RN-APV-86). **Dúvida de produto.**
  2. **Rota da feature:** a feature cita `POST /documents/{id}/approvals`; o contrato real do MVP 1 é DOC-09 (`POST /documents/{id}/submit`), que é o que esta story estende.
  3. **Filtros `overdue`, `dueFrom`, `dueTo` e campo `pendingApprovalDueAt`:** novos, ausentes do catálogo de API do MVP 2 (a consolidar no card 9).
  4. **`ApprovalPolicy` do tipo de documento (MVP 1, §5.7)** descreve um único aprovador e não tem `decisionPolicy`; `entities.md §5.9` diz que `Approval.decisionPolicy` é copiada "da etapa ou da `approvalPolicy` do tipo". Esta story não define aprovação avulsa com várias linhas; RN-APV-81 cobre o caso apenas se US-132/US-133 vierem a estender o schema.
  5. **Aprovação avulsa em etapa de ramo paralelo** não afeta o cálculo (o prazo é do documento), mas a exibição do ramo na caixa é de US-125.

## Impacto técnico
- **Mudança mínima e localizada:** um passo a mais em `RequestApprovalService` (US-051) quando `subjectType = DOCUMENT`; nenhum schema novo, nenhuma migração.
- **Atomicidade:** o cálculo de prazo vem do calendário em memória do tenant (feriados carregados na própria transação); não há chamada de rede nem fila no caminho crítico — o p95 de DOC-09 não muda de forma mensurável.
- **Efeito sobre os tipos já configurados:** órgãos que informaram `slaDays` quando o campo ainda era inerte passam a ter prazo nas próximas solicitações. A mudança é anunciada nas notas de versão e no texto de apoio do formulário do tipo; nenhuma aprovação em andamento é recalculada.
- **Fuso e normalização:** reutiliza a normalização de RN-TRAM-78 (fim do dia no fuso do tenant, `America/Sao_Paulo` por padrão — DEC-003); teste de virada de horário de verão não se aplica ao fuso padrão, mas o cálculo usa a data local do tenant, não a do servidor.
- **Observabilidade:** o prazo e a origem aparecem em `approval.request` e em `ApprovalRequested`, permitindo ao EP-028 distinguir prazo de etapa e prazo de tipo.
- **Compatibilidade:** `dueAt` nulo continua legal para todos os consumidores; filtros novos de APV-01 são opcionais.

## Backend
- **Módulo(s):** `approval` (dono: `RequestApprovalService`, `ListApprovalsQuery`), `document` (DOC-09 como disparo; leitura de `DocumentType.approvalPolicy`), `catalog` (`BusinessCalendarFacade`/`CAL-06`), `audit`.
- **Casos de uso:** `SubmitDocumentCommand` (DOC-09, existente) → `RequestApprovalService.requestForDocument` (estendido com `ComputeApprovalDueDateService`); `ListApprovalsQuery` (filtros `overdue`, `dueFrom`, `dueTo`).
- **Domínio:** `ComputeApprovalDueDateService.forDocument(approvalPolicy, requestedAt, tenantCalendar)` (reaproveita `ComputeStageDueDateService` da US-055); `Approval.dueAt`.
- **Integrações internas:** `BusinessCalendarFacade.addBusinessDays/addCalendarDays` (US-106), `DocumentTypeFacade.getApprovalPolicy`, `OutboxWriter`, `AuditService`.
- **Transação:** a da DOC-09: bloqueio do documento → validações → versão `SUBMISSION` → resolução do aprovador → **cálculo do prazo** → `Approval` + `ApprovalDocument` + `pendingApprovalId` → `ProcessAccess` → auditoria → outbox → timeline → commit.

## Frontend
- **Tela(s):** SCR-013 (`/tarefas`, visão "Aprovações pendentes"), SCR-014 (`/aprovacoes`), SCR-015 (`/aprovacoes/[id]`); o diálogo de submissão fica nas telas dos documentos (reaproveita o diálogo existente de "Enviar para aprovação").
- **Componentes:** `SubmitForApprovalDialog` (linha "Prazo para a decisão", via `CAL-06`), `DueDateBadge` (US-055) e `OverdueBadge` nas três telas, coluna "Prazo" e filtros "Atrasadas" e "Prazo de/até" em `ApprovalFilters`, texto de apoio no formulário do tipo de documento (US-061).
- **Estados:** diálogo com skeleton enquanto o prazo é calculado; "Sem prazo definido" e "Este tipo de documento não tem prazo de aprovação."; selo "Atrasada" por texto e ícone; erro com "Tentar novamente"; aviso de prazo atualizado quando o servidor devolve valor diferente do previsto (FA-06).
- **Acessibilidade e responsividade:** selos de prazo nunca só por cor; data completa no `aria-label` ("Prazo: 24 de novembro de 2026"); diálogo com foco preso e tela cheia abaixo de 768 px; contraste AA.

## Banco de dados
- **Tabelas:** `approvals` (escrita de `due_at` já existente), leitura de `document_types` (`approval_policy`), `holidays`.
- **Migrações:** nenhuma — `Approval.dueAt` e `DocumentType.approvalPolicy.slaDays`/`slaType` já existem (MVP 1).
- **Índices/constraints relevantes:** reaproveita `(tenant_id, document_id) WHERE status = 'PENDING' AND subject_type = 'DOCUMENT'` (unicidade da aprovação avulsa pendente) e `(tenant_id, process_id, created_at DESC)`; possível índice `(tenant_id, due_at) WHERE status = 'PENDING'` em `approvals` para o filtro `overdue`/`dueFrom`/`dueTo`, a confirmar na carga de teste.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `DOC-09` | POST | `/api/v1/documents/{id}/submit` | `{ acknowledgedWarnings?, expectedDraftRevision? }` + `If-Match` + `Idempotency-Key` (MVP 1) | `200 { data: Document }` + `pendingApprovalId` e, aditivo, `pendingApprovalDueAt` | 200, 403, 404, 409, 412, 422, 503 |
| `CAL-06` | POST | `/api/v1/calendar/add-business-days` | `{ fromDateTime, businessDays, dayCountType? }` (preview do prazo no diálogo) | `200 { data: { dueDateTime } }` | 200, 422, 503 |
| `DTY-01` | GET | `/api/v1/document-types` | — | `approvalPolicy.slaDays`/`slaType` por tipo (já existente; origem do preview) | 200, 403 |
| `DTY-03` | PATCH | `/api/v1/document-types/{id}` | `approvalPolicy.slaDays`/`slaType` (já existente) + `If-Match` | `200 { data: DocumentType }` | 200, 403, 404, 412, 422 |
| `APV-01` | GET | `/api/v1/approvals` | MVP 1 + `overdue`, `dueFrom`, `dueTo` | `dueAt` e `isOverdue` (já existentes) agora preenchidos para `DOCUMENT` | 200, 401, 422, 429, 503 |
| `APV-02` | GET | `/api/v1/approvals/{id}` | path `id` | `dueAt` preenchido; sem campo novo | 200, 401, 403, 404, 429, 503 |
| `TSK-01` | GET | `/api/v1/tasks` | `view=PENDING_APPROVALS` | `approval.dueAt` com o prazo próprio da aprovação avulsa (antes, o da etapa) | 200, 401, 403, 422, 429, 503 |

## Logs
- `info` `approval.due_computed` — `approvalId`, `subjectType`, `slaDays`, `slaType`, `dueAt`, `durationMs`, `correlationId`.
- `info` `approval.requested` — já existente; acrescenta `hasDueAt`.
- `warn` `idempotency.store_unavailable`; `warn` `approval.due_policy_ignored` — `slaDays` inválido em dado legado (tratado como sem prazo).
- `error` `approval.due_compute_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** `requestComment`, título do documento, conteúdo das seções.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `approval.request` | `WORKFLOW` | Commit de DOC-09 que cria a `Approval` avulsa | `metadata` (aditivo): `dueAt`, `dueAtSource = DOCUMENT_TYPE` (ausentes sem prazo), `slaDays`, `slaType` |
| `document.submit` | `DATA_CHANGE` | Commit de DOC-09 | Como no MVP 1 |
| `document_type.update` | `CONFIGURATION` | Alteração de `slaDays`/`slaType` (DTY-03, existente) | `changes` campo a campo |
| `access.denied` | `ACCESS` | 403 em DOC-09 ou APV-02 | `reasonCode`, `approvalId`/`documentId` |

## Testes necessários
- **Unitários:** cálculo de `dueAt` com feriado nacional (20/11), fim de semana, `CALENDAR` e `BUSINESS`, virada de mês e de ano, `slaType` ausente, sem `slaDays`; normalização de fim do dia e conversão para UTC; recusa de `slaDays` inválido legado.
- **Integração (Testcontainers):** DOC-09 completo (versão + `Approval` + `ApprovalDocument` + `dueAt` + auditoria + `ApprovalRequested` com `dueAt`); reenvio após devolução; atraso (relógio controlado) com `isOverdue` e status `PENDING` mantido; rollback total na falha do calendário.
- **API/contrato:** `pendingApprovalDueAt` aditivo em DOC-09; filtros de APV-01 (`overdue`, `dueFrom`, `dueTo`); contrato do MVP 1 inalterado para tipo sem prazo.
- **RBAC e multi-tenant:** calendário e tipo de documento isolados por tenant (suíte "tenant leak"); 403/404 de APV-02; feriado de outro tenant ignorado.
- **Concorrência:** duas submissões simultâneas (uma efetiva, a outra 409); alteração do `slaDays` do tipo durante a submissão (usa o valor lido na transação).
- **E2E (Playwright):** admin configura 5 dias úteis → solicitante vê o prazo previsto → envia → aprovador vê o prazo na caixa e na lista → prazo vence (relógio simulado) e o selo "Atrasada" aparece.
- **Acessibilidade/performance:** axe em `SubmitForApprovalDialog` e nos selos; 360 px; p95 de DOC-09 sem regressão (suíte de performance).

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
- [ ] Teste de contrato prova que tipos sem `slaDays` respondem exatamente como no MVP 1
- [ ] Cálculo comprovado com feriado, `CALENDAR` e fuso do tenant (testes de tabela)
- [ ] Nota de versão e texto de apoio informando que `slaDays` do tipo passa a valer nas aprovações avulsas

## Estimativa
**S** — um passo de cálculo na transação já existente, três campos aditivos de contrato e a exibição do prazo em telas que já têm a coluna; o esforço está nos testes de calendário, na compatibilidade com o MVP 1 e no preview do diálogo.

## Prioridade
**P1** — é um débito (DT-17) que não está na lista P2 da DEC-209 e afeta prazos de aprovação já configurados pelos órgãos; não bloqueia o restante do FT-066, por isso fica abaixo das stories P0 do épico.
