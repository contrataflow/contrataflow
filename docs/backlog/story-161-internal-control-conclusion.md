---
id: US-161
title: "Emitir a manifestação e concluir com a situação"
epic: EP-026
feature: FT-077
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-065, US-110, US-129, US-160]
modules: [internal-control, document, process, workflow, rules, notification, timeline, access, audit, platform]
screens: [SCR-020, SCR-006]
endpoints: [ICT-16, ICT-17, ICT-09, DOC-05, DOC-10, DOC-21]
permissions: [INTERNAL_CONTROL_REVIEW_MANAGE, INTERNAL_CONTROL_REVIEW_CONCLUDE, INTERNAL_CONTROL_REVIEW_VIEW, PROCESS_VIEW]
events: [InternalControlReviewConcluded, DocumentFinalized, DocumentVersionCreated, ProcessStageChanged]
---

# US-161 — Emitir a manifestação e concluir com a situação

## Título
Emitir a manifestação do Controle Interno e concluir a análise com a situação conclusiva

## Descrição
**Como** analista do Controle Interno designado para a manifestação (art. 169, II da Lei 14.133/2021), **quero** redigir a manifestação a partir do modelo do órgão, finalizá-la e concluir a análise escolhendo a situação (`COMPLIANT`, `COMPLIANT_WITH_RECOMMENDATIONS` ou `NON_COMPLIANT`), **para** que a autoridade competente receba, na etapa `AUTORIZACAO_LICITACAO`, um documento imutável vinculado às versões exatas que foram analisadas e que o processo possa sair da etapa `CONTROLE_INTERNO`.

A story fecha o ciclo aberto pela US-159 e preenchido pela US-160: cria o documento tipado `MANIFESTACAO_CONTROLE_INTERNO` (ICT-16), reaproveita o editor, as versões e o PDF do MVP 1 (DOC-05, DOC-10 e DOC-21), valida as pré-condições de conclusão (ICT-17) e publica o namespace `internalControl.*` do `RuleContext` v2 (US-129), que alimenta a regra de saída `internalControl.concluded = true` (`BLOCKING`) e o aviso `internalControl.openFindingsHighOrCritical > 0` (`WARNING`). A situação é sempre escolhida por pessoa: nenhuma regra, integração ou IA a preenche (DEC-200). **Geração por IA da manifestação está fora do escopo do MVP 2**: o PRD condicionava-a a uma decisão do card 1, e a DEC-200 e a DEC-202 não a aprovaram (RN-ICT-20).

## Contexto
- DEC-200: a manifestação é um documento tipado (`MANIFESTACAO_CONTROLE_INTERNO`, módulo de sistema `INTERNAL_CONTROL_REPORT`, numeração `MCI {seq:4}/{year}`, `requiresApproval = false`, múltiplos por processo), com situações `COMPLIANT`, `COMPLIANT_WITH_RECOMMENDATIONS` e `NON_COMPLIANT`. A aprovação do que ela contém é a decisão da autoridade em `AUTORIZACAO_LICITACAO` (POL-23).
- `NON_COMPLIANT` e achados abertos **não bloqueiam** o processo por si: seguir adiante exige motivação da autoridade (≥ 50 caracteres) e o reconhecimento dos avisos na autorização (RN-ICT-12, POL-23, ADR-008). Esta story não implementa a decisão da autoridade; ela entrega os fatos (`internalControl.*`) que a autorização lê.
- A manifestação considera o parecer jurídico concluído (`InternalControlReview.legalReviewId`) e grava, na conclusão, as versões exatas analisadas, inclusive a do parecer (`reviewedDocumentVersionIds`, RN-ICT-16), no mesmo espírito do `LegalReviewDocument`.
- Rascunho restrito (POL-24): enquanto não `FINALIZED`, o conteúdo só é lido por quem tem `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo e pelo Auditor; os demais veem título e status.
- Independência (POL-20): quem manifesta não pode ter elaborado os documentos analisados, aprovado ou atuado como procurador no processo; concluir exige ser o `assigneeId` da análise ou o titular/substituto da unidade da etapa. Erro `INTERNAL_CONTROL_SEGREGATION`.
- `INTERNAL_CONTROL_REVIEW_CONCLUDE` é risco `H` (MFA conforme `security.mfaPolicy`); o contrato do `RuleContext` v2 e seu mecanismo de provedores são da US-129 — aqui entra apenas o provedor do módulo `internal-control`.
- A saída da etapa (US-047) continua sendo do encaminhamento: concluir a manifestação satisfaz a regra de saída, mas não encaminha o processo sozinha.

## Objetivo
Garantir que 100% das manifestações concluídas tenham o documento `FINALIZED` com versão vinculada, as versões analisadas congeladas, todas as respostas obrigatórias e achados consistentes com a situação escolhida, e a regra `internalControl.concluded` verdadeira no `RuleContext`, com conclusão atômica e p95 < 2 s (sem contar a geração do PDF, assíncrona).

## Persona
- **Principal:** Analista do Controle Interno (`CONTROLE_INTERNO`), com `INTERNAL_CONTROL_REVIEW_MANAGE` e `INTERNAL_CONTROL_REVIEW_CONCLUDE`.
- **Secundárias:** Titular/substituto da unidade do Controle Interno (conclui no lugar do analista, se não houver conflito); Autoridade competente (`AUTORIDADE_COMPETENTE`, lê a manifestação concluída); Auditor (`AUDITOR`, lê rascunho e trilha); Responsável da etapa seguinte e criador do processo (recebem a notificação).

## Pré-condições
- Usuário autenticado, vínculo `ACTIVE`, tenant `ACTIVE`, sessão com MFA conforme a política do tenant para a permissão `H`.
- `InternalControlReview` em `IN_REVIEW` na etapa `CONTROLE_INTERNO` ativa do processo (ou do ramo), processo editável (POL-03: não `SUSPENDED`, não em status final).
- Respostas e achados já registrados (US-160); o checklist fixado na abertura (US-159) não muda.
- O tipo `MANIFESTACAO_CONTROLE_INTERNO` e seu template padrão existem no tenant (US-110, semente M2).

## Fluxo principal
1. O analista abre o painel da manifestação (SCR-020, `/controle-interno/[reviewId]`) e aciona **"Redigir manifestação"**; o front envia `POST /internal-control/reviews/{id}/manifestation` (ICT-16) com `Idempotency-Key`.
2. A API cria o `Document` `MANIFESTACAO_CONTROLE_INTERNO` a partir da versão publicada do template (seções pré-preenchidas com os fatos do painel: processo, checklist aplicado e versão, resumo das respostas, lista de achados e recomendações, avisos superados — **sem** valores de orçamento sigiloso fora do que a manifestação, restrita, pode conter), vincula `InternalControlReview.reportDocumentId`, numera `MCI {seq:4}/{year}` e responde com o documento. Repetir a chamada devolve o mesmo documento.
3. O analista edita as seções no editor do MVP 1 (DOC-05), com versões automáticas e PDF de rascunho conforme as US-065 a US-067; o conteúdo é restrito (POL-24).
4. Antes de concluir, o painel exibe a **lista de verificação da conclusão** (`GET /internal-control/reviews/{id}`, `meta.conclusionChecklist[]`): respostas obrigatórias pendentes, itens `NON_COMPLIANT` sem achado, situação sugerida pela contagem de achados (só como orientação, nunca preenchida), manifestação ainda em rascunho, resumo ausente.
5. O analista finaliza a manifestação (`POST /documents/{id}/finalize`, DOC-10, `If-Match`): o documento vai a `FINALIZED`, ganha versão final e o PDF é gerado em fila (DEC-018).
6. O analista aciona **"Concluir análise"**, escolhe a situação, informa a ementa (`conclusionSummary`, até 1.000 caracteres, sem dados sigilosos) e confirma (a UI mostra o que acontecerá: "A manifestação ficará imutável e será enviada à autoridade com os achados abertos.").
7. O front envia `POST /internal-control/reviews/{id}/conclude` (ICT-17) com `Idempotency-Key`, `If-Match` e `{ outcome, conclusionSummary }`.
8. A API, em uma transação com `app.tenant_id`: trava a `InternalControlReview`; verifica `IN_REVIEW`; confere `If-Match`; autoriza POL-20 (permissão, independência, designação); valida as pré-condições (RN-ICT-10/11/21): todas as respostas obrigatórias ≠ `PENDING`, todo item `NON_COMPLIANT` com achado vinculado, manifestação `FINALIZED`, `conclusionSummary` preenchido, e requisitos da situação (`COMPLIANT_WITH_RECOMMENDATIONS` ≥ 1 achado com recomendação; `NON_COMPLIANT` ≥ 1 achado `HIGH`/`CRITICAL`); grava `status`, `concludedAt/By`, `reportDocumentVersionId` e `reviewedDocumentVersionIds` (versões vigentes de DFD, ETP, mapa de riscos, pesquisa de preços, TR, dotação/edital quando existirem e o parecer jurídico); torna a análise imutável; grava auditoria `internal_control_review.conclude`, timeline `INTERNAL_CONTROL_CONCLUDED` e o evento `InternalControlReviewConcluded` (outbox) com os fatos para o `RuleContext`.
9. O front invalida o painel, o processo e a caixa de tarefas, mostra "Manifestação concluída: {situação}." e destaca que a etapa pode ser encaminhada.

## Fluxos alternativos
- **FA-01 — Lista de verificação com pendências:** o botão "Concluir análise" fica habilitado, mas a API responde 422 com a lista de pendências (`details[]`); a UI leva ao item pendente (RN-ICT-10).
- **FA-02 — Situação incompatível com os achados:** escolher `NON_COMPLIANT` sem achado `HIGH`/`CRITICAL`, ou `COMPLIANT_WITH_RECOMMENDATIONS` sem achado com recomendação, retorna 422 `INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED` com a regra violada (RN-ICT-11).
- **FA-03 — `COMPLIANT` com achados abertos:** permitido apenas se todos os achados estiverem `ADDRESSED`/`CANCELED`; achado `OPEN` com `COMPLIANT` retorna 422 (RN-ICT-45).
- **FA-04 — Manifestação ainda em rascunho:** a API responde 422 `INTERNAL_CONTROL_REPORT_NOT_FINALIZED`; o botão "Finalizar manifestação" é oferecido no mesmo diálogo.
- **FA-05 — Conflito de independência:** o usuário atuou no processo (autor de documento, aprovador ou procurador); 403 `INTERNAL_CONTROL_SEGREGATION`; a UI orienta pedir a redistribuição ao titular da unidade (RN-ICT-14).
- **FA-06 — Versão analisada mudou:** algum documento da cadeia ganhou nova versão depois do início da rodada; a conclusão exibe o aviso "Documentos alterados desde o início da análise: {lista}" e exige o reconhecimento (`acknowledgedOutdatedDocuments`), que fica na auditoria (RN-ICT-46).
- **FA-07 — Processo devolvido antes da conclusão:** a análise permanece `IN_REVIEW`; na volta abre-se nova rodada reaproveitando respostas e achados (RN-ICT-18, US-159); concluir só vale na rodada corrente.
- **FA-08 — Cancelamento do processo ou do ramo:** a manifestação aberta vai a `CANCELED` com motivo e o documento em rascunho é preservado (RN-ICT-19).
- **FA-09 — Nova manifestação após análise concluída:** só nasce se o processo voltar a `CONTROLE_INTERNO` depois de concluída a anterior; a anterior permanece imutável e lida no histórico.

## Regras de negócio
- **RN-ICT-10** — Concluir exige todas as respostas obrigatórias diferentes de `PENDING`, a manifestação `FINALIZED` e `conclusionSummary` preenchido (DEC-200).
- **RN-ICT-11** — `COMPLIANT_WITH_RECOMMENDATIONS` exige ao menos um achado com recomendação; `NON_COMPLIANT` exige ao menos um achado `HIGH` ou `CRITICAL` (DEC-200).
- **RN-ICT-12** — `NON_COMPLIANT` e achados abertos **não bloqueiam** o processo por si: seguir adiante exige motivação da autoridade (≥ 50 caracteres) e o reconhecimento dos avisos na autorização (DEC-200, POL-23).
- **RN-ICT-13** — A saída de `CONTROLE_INTERNO` exige `internalControl.concluded = true` (`BLOCKING`); `internalControl.openFindingsHighOrCritical > 0` gera `WARNING` na autorização (DEC-200).
- **RN-ICT-14** — Quem manifesta não pode ter elaborado os documentos analisados nem aprovar o que analisou (segregação da POL-20) (DEC-200).
- **RN-ICT-15** — Enquanto não finalizada, a manifestação só é lida por quem tem `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo e pelo Auditor (POL-24) (DEC-200).
- **RN-ICT-16** — A conclusão grava as versões exatas analisadas (`reviewedDocumentVersionIds`, inclusive o parecer) e a versão da manifestação (DEC-200).
- **RN-ICT-20** — Não há geração por IA na manifestação: `AI_GENERATE` não se aplica ao tipo `MANIFESTACAO_CONTROLE_INTERNO` (DEC-200, DEC-202). Fora do escopo do MVP 2.
- **RN-ICT-40** — A situação conclusiva é escolhida por pessoa com `INTERNAL_CONTROL_REVIEW_CONCLUDE`; a contagem de achados apenas orienta e nunca preenche `outcome` (DEC-200).
- **RN-ICT-41** — A análise concluída é imutável (trigger no banco): `status`, respostas, achados e vínculos não mudam, salvo o atendimento de achado pela US-162 (que não altera a situação nem a manifestação) e o cancelamento por processo cancelado antes da conclusão.
- **RN-ICT-42** — `InternalControlReview.legalReviewId` é fixado na conclusão com a análise jurídica concluída mais recente do processo, quando existir; sem parecer concluído (ex.: dispensa `WAIVED`), registra a dispensa em `reviewedDocumentVersionIds` como ausência explícita e o painel avisa.
- **RN-ICT-43** — O provedor `internalControl` do `RuleContext` v2 devolve `exists`, `status`, `concluded` (verdadeiro nas três situações conclusivas), `openFindings` e `openFindingsHighOrCritical`; valores de orçamento sigiloso nunca entram (DEC-030, US-129).
- **RN-ICT-44** — O texto da manifestação, a ementa e os eventos não carregam valores de orçamento sigiloso fora do documento restrito; `conclusionSummary` é validado contra os campos sigilosos conhecidos do processo (DEC-030).
- **RN-ICT-45** — Achado `OPEN` impede a conclusão com `COMPLIANT`; os achados seguem na manifestação e na visão da autoridade (reforça RN-ICT-11).
- **RN-ICT-46** — Se alguma versão de documento da cadeia mudou desde o início da rodada, a conclusão exige o reconhecimento explícito, registrado na auditoria e no evento.

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação | `outcome` | `InternalControlReviewStatus` (`COMPLIANT`, `COMPLIANT_WITH_RECOMMENDATIONS`, `NON_COMPLIANT`) | Sim | RN-ICT-11, RN-ICT-45 | escolha manual |
| Ementa da manifestação | `conclusionSummary` | texto (10–1.000) | Sim | sem dados sigilosos (RN-ICT-44) | — |
| Reconheço documentos alterados | `acknowledgedOutdatedDocuments` | lista de tipos | Condicional | exigida em FA-06 | calculada |
| Seções da manifestação | `Document.draftContent.sections` | texto estruturado | Sim para finalizar | template do órgão | template `MANIFESTACAO_CONTROLE_INTERNO` |
| *(saída)* Versão da manifestação | `reportDocumentVersionId` | uuid | — | `FINALIZED` | DOC-10 |
| *(saída)* Versões analisadas | `reviewedDocumentVersionIds` | uuid[] | — | imutáveis | congeladas na conclusão |
| *(saída)* Lista de verificação | `meta.conclusionChecklist[]` | lista | — | RN-ICT-10/11 | calculada |
| ETag da análise | `If-Match` | string | Sim | RN de concorrência | `meta.etag` de ICT-09 |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `outcome` ausente ou fora das três situações conclusivas | Front + API (Zod) | "Escolha a situação da manifestação." | `VALIDATION_ERROR` |
| V-02 | `conclusionSummary` vazio ou fora de 10–1.000 caracteres | Front + API | "Informe a ementa da manifestação (até 1.000 caracteres)." | `VALIDATION_ERROR` |
| V-03 | Resposta obrigatória `PENDING` | API | "Há {n} item(ns) obrigatório(s) do checklist sem resposta." | `INTERNAL_CONTROL_ANSWERS_PENDING` |
| V-04 | Item `NON_COMPLIANT` sem achado vinculado | API | "O item {itemKey} está não conforme e precisa de um achado." | `INTERNAL_CONTROL_FINDING_REQUIRED` |
| V-05 | Manifestação não `FINALIZED` | API | "Finalize a manifestação antes de concluir." | `INTERNAL_CONTROL_REPORT_NOT_FINALIZED` |
| V-06 | Situação sem respaldo nos achados (RN-ICT-11, RN-ICT-45) | API | "A situação escolhida não é compatível com os achados registrados." | `INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED` |
| V-07 | `conclusionSummary` com dado sigiloso | API | "A ementa não pode conter valores de orçamento sigiloso." | `VALIDATION_ERROR` (`CONFIDENTIAL_CONTENT`) |
| V-08 | Documentos alterados sem reconhecimento | API | "Documentos mudaram desde o início da análise. Reconheça para concluir." | `OUTDATED_DOCUMENTS_NOT_ACKNOWLEDGED` |
| V-09 | `If-Match` ausente | API | "Recarregue a análise e tente de novo." | `PRECONDITION_REQUIRED` |

## Permissões
- **Permissão:** `INTERNAL_CONTROL_REVIEW_MANAGE` com escopo que cubra o processo (criar, editar e finalizar a manifestação — ICT-16, DOC-05, DOC-10); `INTERNAL_CONTROL_REVIEW_CONCLUDE` (concluir — ICT-17); `INTERNAL_CONTROL_REVIEW_VIEW` e `PROCESS_VIEW` para ler a manifestação concluída.
- **Políticas:** POL-20 (independência e designação), POL-24 (rascunho restrito), POL-02 (edição de documento, estendida ao tipo novo), POL-03 (processo editável), POL-09 (orçamento sigiloso).
- **MFA:** exigido para ICT-17 (permissão `H`) conforme `security.mfaPolicy`; ICT-16 e a edição, não (risco `M`).
- **Sem permissão:** a UI oculta "Redigir manifestação" e "Concluir análise"; a API responde 403 `PERMISSION_DENIED`, `INTERNAL_CONTROL_SEGREGATION` ou `DOCUMENT_DRAFT_RESTRICTED` e grava `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `DocumentVersionCreated` | `document.version_created` | Edição da manifestação e finalização | MVP 1 |
| `DocumentFinalized` | `document.finalized.manifestacao_controle_interno` | Commit de DOC-10 | Nome especializado `InternalControlReportIssued`; fila de PDF |
| `InternalControlReviewConcluded` | `internal_control_review.concluded` | Commit de ICT-17 | `reviewId`, `status`, `round`, `reportDocumentVersionId`, `findingsCount`, `highOrCriticalCount`; alimenta timeline `INTERNAL_CONTROL_CONCLUDED`, notificação, read model e `RuleContext` |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `INTERNAL_CONTROL_CONCLUDED` | Criador do processo; responsável da etapa seguinte; titular da secretaria solicitante | in-app + e-mail | `InternalControlReviewConcluded` |

## Critérios de aceite em Gherkin
```gherkin
Feature: Emitir a manifestação e concluir a análise do Controle Interno

  Background:
    Given que o tenant "Prefeitura A" está ativo com a nova versão do workflow adotada
    And o processo "0045/2026" está na etapa "CONTROLE_INTERNO" com a manifestação "IN_REVIEW" designada a "Renata Prado"
    And "Renata Prado" tem "INTERNAL_CONTROL_REVIEW_MANAGE" e "INTERNAL_CONTROL_REVIEW_CONCLUDE" e não atuou no processo
    And o checklist fixado tem 12 itens, 10 obrigatórios, todos respondidos, e há 1 achado "MEDIUM" com recomendação
    And o parecer jurídico "PJ 0007/2026" está concluído como "FAVORABLE"

  Scenario: [Sucesso] Redigir, finalizar e concluir como conforme com recomendações
    When "Renata Prado" chamar "POST /internal-control/reviews/{id}/manifestation"
    Then a API deve responder 201 com o documento "MCI 0001/2026" em "DRAFT" vinculado à análise
    When "Renata Prado" finalizar o documento
    Then o documento deve ficar "FINALIZED" com versão final e PDF em fila
    When "Renata Prado" concluir com "outcome" "COMPLIANT_WITH_RECOMMENDATIONS" e a ementa "Processo regular, com recomendação de ajuste na matriz de riscos."
    Then a API deve responder 200 com status "COMPLIANT_WITH_RECOMMENDATIONS" e "reviewedDocumentVersionIds" incluindo a versão do parecer "PJ 0007/2026"
    And deve gerar registro de auditoria "internal_control_review.conclude"
    And deve gerar o evento "InternalControlReviewConcluded" e a notificação "INTERNAL_CONTROL_CONCLUDED"
    And "internalControl.concluded" deve ser verdadeiro no contexto de regras do processo
    And a regra de saída da etapa "CONTROLE_INTERNO" deve ficar satisfeita

  Scenario: [Sucesso] Concluir como não conforme não bloqueia o processo
    Given que há um achado "HIGH" aberto e a manifestação está "FINALIZED"
    When "Renata Prado" concluir com "outcome" "NON_COMPLIANT"
    Then a API deve responder 200 e a análise deve ficar "NON_COMPLIANT"
    And o processo deve poder ser encaminhado, com "internalControl.openFindingsHighOrCritical" igual a 1 gerando aviso "WARNING" na autorização

  Scenario: [Validação] Conclusão com pendências e situação sem respaldo
    Given que 2 itens obrigatórios do checklist estão "PENDING"
    When "Renata Prado" tentar concluir
    Then a API deve responder 422 com código "INTERNAL_CONTROL_ANSWERS_PENDING" listando os itens
    Given que não há achado "HIGH" nem "CRITICAL" e as respostas estão completas
    When "Renata Prado" concluir com "outcome" "NON_COMPLIANT"
    Then a API deve responder 422 com código "INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED"
    And a manifestação não deve ficar concluída
    Given que a manifestação ainda está em "DRAFT"
    When "Renata Prado" tentar concluir
    Then a API deve responder 422 com código "INTERNAL_CONTROL_REPORT_NOT_FINALIZED"

  Scenario: [Permissão] Sem permissão, sem independência e rascunho restrito
    Given que "Paulo Dias" não tem "INTERNAL_CONTROL_REVIEW_CONCLUDE"
    When "Paulo Dias" chamar "POST /internal-control/reviews/{id}/conclude"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar auditoria "access.denied"
    Given que "Marcos Lima" tem as permissões, mas foi aprovador do DFD do processo
    When "Marcos Lima" tentar concluir
    Then a API deve responder 403 com código "INTERNAL_CONTROL_SEGREGATION"
    Given que "Carla Mendes", requisitante, tem "PROCESS_VIEW" e a manifestação está em rascunho
    When "Carla Mendes" abrir o documento
    Then a API deve responder 403 com código "DOCUMENT_DRAFT_RESTRICTED" e exibir só título e status

  Scenario: [Tenant incorreto] Análise de outro tenant
    Given que existe a manifestação "MCI 0009/2026" da "Prefeitura B"
    When "Renata Prado", da "Prefeitura A", chamar "POST /internal-control/reviews/{id-da-Prefeitura-B}/conclude"
    Then a API deve responder 404 com código "INTERNAL_CONTROL_REVIEW_NOT_FOUND"
    And nenhum dado da "Prefeitura B" deve ser alterado ou exposto

  Scenario: [Duplicidade] Reenvio da conclusão com a mesma chave de idempotência
    Given que "Renata Prado" concluiu com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo resultado e o cabeçalho "Idempotent-Replayed: true"
    And deve existir um único evento "InternalControlReviewConcluded" e uma única auditoria "internal_control_review.conclude"
    When "Renata Prado" chamar "POST /internal-control/reviews/{id}/manifestation" duas vezes
    Then deve existir um único documento "MCI" vinculado à análise

  Scenario: [Concorrência] Conclusão simultânea e edição durante a conclusão
    When "Renata Prado" e o titular "Dr. Otávio" concluírem a mesma análise ao mesmo tempo
    Then exatamente uma conclusão deve responder 200
    And a outra deve responder 409 com código "INVALID_STATE" ou 412 com código "VERSION_CONFLICT"
    Given que "Renata Prado" abriu o diálogo com a ETag "E1" e um achado foi registrado em outra aba
    When ela concluir com "If-Match" "E1"
    Then a API deve responder 412 com código "VERSION_CONFLICT" e a UI deve recarregar o painel

  Scenario: [Falha de banco] Falha ao gravar a conclusão
    Given que o banco de dados fica indisponível durante a transação de "POST /internal-control/reviews/{id}/conclude"
    When "Renata Prado" confirmar a conclusão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "IN_REVIEW" sem auditoria, evento ou versão vinculada gravados

  Scenario: [Falha de integração] Gotenberg indisponível na geração do PDF
    Given que o Gotenberg está indisponível
    When "Renata Prado" finalizar a manifestação e concluir a análise
    Then a conclusão deve ser gravada e a análise deve ficar concluída
    And o PDF deve ficar "PENDING" na fila com nova tentativa automática e alerta "document.pdf_failed" após as tentativas
    And a UI deve exibir "O PDF está sendo gerado. Você já pode consultar o texto da manifestação."
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Respostas obrigatórias pendentes | 422 | `INTERNAL_CONTROL_ANSWERS_PENDING` | "Há {n} item(ns) obrigatório(s) do checklist sem resposta." | Lista e leva ao item |
| Item não conforme sem achado | 422 | `INTERNAL_CONTROL_FINDING_REQUIRED` | "O item {itemKey} está não conforme e precisa de um achado." | Abre o formulário de achado |
| Manifestação em rascunho | 422 | `INTERNAL_CONTROL_REPORT_NOT_FINALIZED` | "Finalize a manifestação antes de concluir." | Oferece "Finalizar manifestação" |
| Situação sem respaldo | 422 | `INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED` | "A situação escolhida não é compatível com os achados registrados." | Destaca a regra |
| Documentos alterados sem reconhecimento | 422 | `OUTDATED_DOCUMENTS_NOT_ACKNOWLEDGED` | "Documentos mudaram desde o início da análise. Reconheça para concluir." | Exibe a lista e o aceite |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir esta análise." | Oculta a ação |
| Conflito de independência | 403 | `INTERNAL_CONTROL_SEGREGATION` | "Você atuou neste processo e não pode manifestar sobre ele." | Orienta pedir redistribuição |
| Rascunho restrito | 403 | `DOCUMENT_DRAFT_RESTRICTED` | "A manifestação está em elaboração." | Mostra título e status |
| Análise inexistente ou de outro tenant | 404 | `INTERNAL_CONTROL_REVIEW_NOT_FOUND` | "Análise não encontrada." | Volta à fila |
| Análise não está em andamento | 409 | `INVALID_STATE` | "Esta análise não está mais em andamento." | Recarrega |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A análise foi alterada. Recarregue e confira antes de concluir." | Recarrega o painel |
| Chave de idempotência reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | "Tentar novamente"; respeita `Retry-After` |

## Dependências
- **Stories:** US-065 (ciclo de vida e finalização do documento), US-110 (biblioteca de templates — modelo da manifestação), US-129 (`RuleContext` v2 — provedor `internalControl`), US-160 (respostas e achados). Indiretas: US-159 (abertura e painel), US-066/US-067 (versões e PDF), US-047 (encaminhamento e regra de saída), US-155 (parecer jurídico concluído lido pela manifestação), US-130 (workflow v2 que usa a regra de saída).
- **Decisões/ADRs:** DEC-018, DEC-030, DEC-196, DEC-200, DEC-202 (sem IA na manifestação), ADR-008.
- **Configurações:** `internalControl.defaultChecklistKey` (indireta, via US-158).
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos** (`INTERNAL_CONTROL_ANSWERS_PENDING`, `INTERNAL_CONTROL_FINDING_REQUIRED`, `INTERNAL_CONTROL_REPORT_NOT_FINALIZED`, `INTERNAL_CONTROL_OUTCOME_NOT_SUPPORTED`, `INTERNAL_CONTROL_REVIEW_NOT_FOUND`, `OUTDATED_DOCUMENTS_NOT_ACKNOWLEDGED`) e o campo `meta.conclusionChecklist[]` não existem em `permissions.md`/`events.md`/catálogo de API; consolidar no card 9. `INTERNAL_CONTROL_SEGREGATION` já existe (POL-20).
  2. **Reconhecimento de documentos alterados** (`acknowledgedOutdatedDocuments`, FA-06) e a ausência explícita de parecer (RN-ICT-42) não estão em `entities.md`; proposta: campos no payload do evento e na auditoria, sem coluna nova. **Dúvida de produto.**
  3. **Auditoria `internal_control_review.conclude`** está na matriz de `events.md`; falta a ação de auditoria de criação do documento (`internal_control_review.report_create`, proposta).
  4. **IA na manifestação:** fora do escopo do MVP 2 (RN-ICT-20); reabrir só por nova DEC.

## Impacto técnico
- Reaproveita o ciclo de vida de documento (DEC-018) e o editor do MVP 1; a novidade é o tipo `MANIFESTACAO_CONTROLE_INTERNO`, seu template e a regra POL-24 para rascunho restrito.
- A conclusão é uma transação curta e o PDF é assíncrono (Gotenberg em fila — US-067), para manter o p95; falha de PDF não desfaz a conclusão.
- Imutabilidade da análise concluída por trigger no banco, com exceção do atendimento de achados (US-162), isolada em colunas próprias de `internal_control_findings`.
- O provedor `internalControl` do `RuleContext` v2 é publicado aqui e deve ser idempotente e barato (leitura de contadores por `review_id`).
- Compatibilidade: eventos novos nascem com `eventVersion = 1`; nenhuma rota do MVP 1 muda de contrato.

## Backend
- **Módulo(s):** `internal-control` (dono), `document` (tipo e template), `workflow`/`rules` (provedor do `RuleContext`), `notification`, `timeline`, `audit`.
- **Casos de uso:** `CreateInternalControlManifestationCommand` (ICT-16), `ConcludeInternalControlReviewCommand` (ICT-17), `GetInternalControlReviewQuery` (ICT-09, com `conclusionChecklist`); `InternalControlRuleContextProvider`.
- **Domínio:** `InternalControlReview` (invariantes da §4.4 e RN-ICT-10/11/21), `ConclusionChecklistService`, `ReviewedVersionsSnapshot`.
- **Integrações internas:** `DocumentFacade` (criar do template, finalizar, versão vigente), `ProcessFacade` (autoria, aprovações e designações para POL-20), `LegalReviewFacade` (parecer concluído), `OutboxWriter`, `AuditService`.
- **Transação:** trava da análise → validações → gravação da conclusão e do snapshot → auditoria → outbox → timeline → commit; PDF e notificações fora da transação.

## Frontend
- **Tela(s):** SCR-020 (`/controle-interno/[reviewId]`), SCR-006 (aba "Controle Interno" do processo).
- **Componentes:** `ManifestationEditor` (editor do MVP 1), `ConclusionChecklistPanel`, `ConcludeReviewDialog` (situação, ementa, aceite de documentos alterados), `ReviewedVersionsList`, `OutcomeBadge`.
- **Estados:** skeleton, vazio ("Manifestação ainda não iniciada"), erro com "Tentar novamente", sucesso com a situação; botão "Concluir" desabilitado com o motivo quando faltar finalizar.
- **Acessibilidade e responsividade:** situação com texto e ícone (nunca só cor), diálogo com foco preso, tela cheia abaixo de 768 px, lista de verificação navegável por teclado.

## Banco de dados
- **Tabelas:** `internal_control_reviews`, `internal_control_checklist_answers`, `internal_control_findings`, `documents`, `document_versions`.
- **Migrações:** nenhuma além da M2 do módulo (tabelas da §4.4 e trigger de imutabilidade); sementes do tipo e template `MANIFESTACAO_CONTROLE_INTERNO`.
- **Índices/constraints relevantes:** check de conclusão (`status` conclusivo exige `concluded_at`, `report_document_version_id` e `conclusion_summary`); `(tenant_id, process_id) WHERE status IN ('PENDING','IN_REVIEW')`; índice parcial de achados `OPEN`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `ICT-16` | POST | `/api/v1/internal-control/reviews/{id}/manifestation` | `Idempotency-Key` | `201 { data: Document }` (ou `200` se já existe) | 200, 201, 403, 404, 409, 503 |
| `ICT-17` | POST | `/api/v1/internal-control/reviews/{id}/conclude` | `{ outcome, conclusionSummary, acknowledgedOutdatedDocuments? }` + `If-Match` + `Idempotency-Key` | `200 { data: InternalControlReview }` | 200, 403, 404, 409, 412, 422, 503 |
| `ICT-09` | GET | `/api/v1/internal-control/reviews/{id}` | path `id` | painel + `meta.conclusionChecklist[]`, `meta.etag` | 200, 403, 404 |
| `DOC-05` | PUT | `/api/v1/documents/{id}/sections/{sectionKey}` | MVP 1 (tipo novo) | MVP 1 | 200, 403, 409, 412, 422 |
| `DOC-10` | POST | `/api/v1/documents/{id}/finalize` | MVP 1 (tipo novo) | MVP 1 | 200, 403, 409, 412, 422 |
| `DOC-21` | POST | `/api/v1/document-versions/{versionId}/renditions` | MVP 1 (PDF da versão final, em fila) | MVP 1 (rendição `PENDING`/`READY`) | 200, 202, 403, 404 |

## Logs
- `info` `internal_control.manifestation_created` — `reviewId`, `documentId`, `correlationId`.
- `info` `internal_control.review_concluded` — `reviewId`, `outcome`, `round`, `findingsCount`, `highOrCriticalCount`, `durationMs`.
- `warn` `internal_control.conclusion_rejected` — `reviewId`, `errorCode`; `warn` `internal_control.outdated_documents_acknowledged` — `reviewId`, tipos.
- `error` `internal_control.conclude_failed` — `errorCode`, causa resumida.
- **Nunca logar:** texto da manifestação, ementa, descrição de achados, valores de orçamento sigiloso.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `internal_control_review.conclude` | `WORKFLOW` | Commit de ICT-17 | `changes` de `status`; `metadata`: `round`, `reportDocumentVersionId`, contagens, `acknowledgedOutdatedDocuments` |
| `document.finalize` | `DATA_CHANGE` | Commit de DOC-10 | MVP 1 |
| `document.create` | `DATA_CHANGE` | Commit de ICT-16 | `documentTypeCode`, `reviewId` |
| `access.denied` | `ACCESS` | 403 em qualquer rota da story | `reasonCode`, `reviewId` |

## Testes necessários
- **Unitários:** `ConclusionChecklistService` (pendências, achado exigido, situação × achados, `COMPLIANT` com achado aberto), snapshot de versões analisadas, POL-20, provedor do `RuleContext`.
- **Integração (Testcontainers):** ICT-16/ICT-17 ponta a ponta com documento, versões, auditoria, outbox e regra de saída; trigger de imutabilidade; rollback total na falha; PDF assíncrono com falha do Gotenberg.
- **API/contrato:** corpo e erros de ICT-16/ICT-17, `meta.conclusionChecklist[]`, idempotência e `If-Match`.
- **RBAC e multi-tenant:** 403/404 por papel e tenant, rascunho restrito (POL-24), independência (POL-20); teste novo na suíte "tenant leak".
- **Concorrência:** duas conclusões simultâneas e conclusão com ETag velha.
- **E2E (Playwright):** redigir → finalizar → concluir → encaminhar o processo à `AUTORIZACAO_LICITACAO` → autoridade vê a manifestação.
- **Acessibilidade/performance:** axe no diálogo e no editor; p95 da conclusão < 2 s (suíte de performance).

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
- [ ] Provedor `internalControl` do `RuleContext` v2 coberto por teste de contrato
- [ ] Teste prova que a análise concluída é imutável (trigger) e que nenhuma IA/regra preenche a situação

## Estimativa
**M** — duas rotas novas e a reutilização do editor, versões e PDF do MVP 1; o esforço está nas validações cruzadas da conclusão, no snapshot das versões analisadas, na independência POL-20 e no provedor do `RuleContext`.

## Prioridade
**P0** — sem a conclusão da manifestação a regra de saída de `CONTROLE_INTERNO` não é satisfeita e a fase preparatória da v2 não fecha (DEC-015, US-130).
