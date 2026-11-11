---
id: US-155
title: "Concluir a análise com a situação conclusiva"
epic: EP-025
feature: FT-074
mvp: 2
priority: P0
estimate: M
status: Especificada
depends_on: [US-129, US-154]
modules: [legal-review, document, workflow, process, timeline, notification, audit, access]
screens: [SCR-019, SCR-006, SCR-015]
endpoints: [LGL-19, LGL-02, LGL-24, LGL-16, DOC-10]
permissions: [LEGAL_REVIEW_CONCLUDE, LEGAL_REVIEW_VIEW, PROCESS_VIEW]
events: [LegalReviewConcluded, DocumentFinalized]
---

# US-155 — Concluir a análise com a situação conclusiva

## Título
Concluir a análise jurídica com a situação conclusiva

## Descrição
**Como** procurador responsável pela análise jurídica de um processo, **quero** concluir a análise escolhendo eu mesmo a situação conclusiva (favorável, favorável com ressalvas ou desfavorável) e registrando a ementa do parecer, **para** que o parecer finalizado fique vinculado, de forma imutável, às versões que analisei, a regra de saída da etapa `JURIDICO` seja satisfeita e as etapas seguintes enxerguem o resultado e as ressalvas.

Concluir é o ato final de `LegalReview`: grava `status`, `conclusionSummary`, `opinionDocumentVersionId`, `concludedAt` e `concludedById`, completa `LegalReviewDocument` da rodada corrente com a versão do parecer e torna a análise imutável (DEC-199). A situação é **sempre escolhida por pessoa**; nenhuma regra, IA ou integração a preenche (DEC-202). O parecer **não vincula**: `UNFAVORABLE` não bloqueia o processo; a autoridade segue com motivação e reconhecimento de avisos na etapa de autorização (POL-23, ADR-008). A story publica também o provedor do namespace `legalReview.*` do `RuleContext` v2 (contrato fixado na US-129) e a regra de saída padrão `legalReview.concluded = true`.

## Contexto
- Art. 53 da Lei 14.133/2021: o parecer jurídico é obrigatório na fase preparatória e é um ato opinativo, não vinculante. O produto separa o **documento** `PARECER_JURIDICO` (elaborado e finalizado no editor — US-154, ciclo de vida da DEC-018) da **conclusão da análise** (esta story), porque a situação conclusiva e a ementa são dados tipados que o fluxo, a fila, as regras e a autorização precisam ler sem interpretar texto.
- DEC-199 define `LegalReview`, `LegalReviewDocument` e as situações; DEC-196 mantém a análise aberta durante diligências (rodadas) e só cria nova `LegalReview` se o processo voltar a `JURIDICO` depois de uma análise concluída; DEC-202 proíbe a IA de propor ou preencher a situação; DEC-205 define a pausa de SLA que termina ao sair de `DILIGENCE`.
- US-154 entrega o parecer em rascunho, as ressalvas (`LegalReviewReservation`, LGL-16..LGL-18) e a finalização do documento (DOC-10). US-122 (MVP 1) obriga a revisão humana das seções geradas por IA antes de finalizar; esta story confere de novo no ato de concluir (defesa em profundidade, RN-LGL-17).
- US-129 fixa o mecanismo de provedores por namespace do `RuleContext` v2 (falha fechada, montagem preguiçosa, cache por requisição — RN-WF2-82/84); o módulo `legal-review` registra o provedor de `legalReview` (`exists`, `status`, `concluded`, `round`, `openReservations`, `waived`, `outdatedDocuments`).
- Segregação (POL-19): quem elaborou o processo ou documentos dele não conclui; concluir exige ainda ser o `assigneeId` da análise ou o titular/substituto da unidade jurídica da etapa.
- A análise concluída é lida por quem tem `PROCESS_VIEW` (o parecer finalizado é um documento visível como os demais — POL-24 só restringe o rascunho).

## Objetivo
Garantir que 100% das análises concluídas tenham situação escolhida por pessoa autorizada e segregada, parecer `FINALIZED` vinculado por versão, ementa sem dados sigilosos, ressalvas coerentes com a situação e nenhuma alteração posterior possível, e que a etapa `JURIDICO` seja liberada pela regra `legalReview.concluded` em até 1 s após o commit.

## Persona
- **Principal:** Procurador / Jurídico (perfil `JURIDICO`) — designado (`assigneeId`) ou titular/substituto da unidade jurídica.
- **Secundárias:** Responsável da etapa seguinte (`CONTROLE_INTERNO`), criador do processo e titular da secretaria solicitante (notificados); Autoridade competente (`AUTORIDADE_COMPETENTE`, lê o parecer e motiva a decisão diante de `UNFAVORABLE`); Auditor (`AUDITOR`).

## Pré-condições
- `LegalReview` em `IN_REVIEW` na etapa `JURIDICO` ativa do processo (nunca `PENDING`, `DILIGENCE`, `WAIVED`, `CANCELED` nem já concluída).
- `opinionDocumentId` preenchido e documento `PARECER_JURIDICO` em `FINALIZED` (DEC-018), sem seção gerada por IA pendente de revisão e sem marcação `[a confirmar]` bloqueante (US-122).
- Usuário com `LEGAL_REVIEW_CONCLUDE` cobrindo o processo, segregado (POL-19) e `assigneeId` da análise ou titular/substituto da unidade jurídica da etapa.
- MFA válido na sessão quando `security.mfaPolicy` exigir (permissão de risco `H`).
- Em `FAVORABLE_WITH_RESERVATIONS`, ao menos uma `LegalReviewReservation` registrada na análise.

## Fluxo principal
1. O procurador abre o painel de análise (`/juridico/[reviewId]`, SCR-019), que mostra a rodada, as versões analisadas, o parecer, as ressalvas e a lista de verificação de conclusão (`ConclusionChecklist`: parecer finalizado, seções de IA revisadas, ressalvas, ementa).
2. Com o parecer finalizado, a ação **"Concluir análise"** fica habilitada; se faltar algo, aparece desabilitada com o motivo e o atalho para resolvê-lo (ex.: "Finalize o parecer", "Revise as seções geradas por IA").
3. O diálogo `ConcludeLegalReviewDialog` mostra o resumo do que será vinculado (parecer `PJ 0007/2026` versão 3, rodada 2, versões analisadas por documento, ressalvas `OPEN`) e pede, **sem valor pré-selecionado**: a **situação conclusiva** (três opções com texto explicativo) e a **ementa** (contador 0..1.000).
4. Ao escolher "Favorável com ressalvas", o diálogo lista as ressalvas registradas; sem nenhuma, a opção fica indisponível com o atalho "Registrar ressalva" (LGL-17). Ao escolher "Desfavorável", exibe o aviso informativo "O parecer não bloqueia o processo; a autoridade poderá prosseguir com motivação."
5. O procurador confirma; o front envia `POST /legal-reviews/{id}/conclude` (LGL-19) com `{ status, conclusionSummary }`, `If-Match` (ETag da análise) e `Idempotency-Key`. Se a política de MFA exigir, a API responde 403 `MFA_REQUIRED` e o front abre o desafio, repetindo a chamada ao validar.
6. A API, em uma transação, trava `LegalReview` (`SELECT … FOR UPDATE`), valida a situação, a segregação (POL-19), o estado, o parecer `FINALIZED`, a revisão das seções de IA, as ressalvas e a ementa (RN-LGL-16..18, 60..62).
7. Grava `status`, `conclusionSummary`, `opinionDocumentVersionId` (versão `FINALIZED` do parecer), `concludedAt`, `concludedById`; completa `LegalReviewDocument` da rodada corrente com o parecer e a versão dele; zera `currentProcessStageId` apenas quando a passagem termina (a tramitação cuida); grava auditoria `legal_review.conclude`, a linha de timeline `LEGAL_REVIEW_CONCLUDED` e o evento `LegalReviewConcluded` no outbox.
8. A API responde 200 com a `LegalReview` concluída. O provedor `legalReview.*` passa a devolver `concluded = true`, `status`, `round`, `openReservations` e `outdatedDocuments`; a regra de saída `legalReview.concluded = true` da etapa `JURIDICO` fica satisfeita e o responsável pode encaminhar (US-041/047) — a conclusão não move o processo sozinha.
9. O painel passa ao modo somente leitura, com selo da situação, ementa, versão do parecer vinculada, ressalvas e links; as notificações `LEGAL_REVIEW_CONCLUDED` saem após o commit (outbox).
10. Mais adiante, na etapa `AUTORIZACAO_LICITACAO`, `UNFAVORABLE` ou ressalvas `OPEN` geram aviso `WARNING` que a autoridade precisa reconhecer e motivar (RN-LGL-19, RN-LGL-67).

## Fluxos alternativos
- **FA-01 — Parecer ainda em rascunho:** a ação fica desabilitada; se o front for contornado, LGL-19 responde 422 `LEGAL_OPINION_NOT_FINALIZED` e o painel oferece "Abrir o parecer" (RN-LGL-16).
- **FA-02 — Seções de IA sem revisão:** LGL-19 responde 422 `DOCUMENT_INCOMPLETE` com as violações `SECTION_AI_REVIEW_PENDING` (e `SECTION_PLACEHOLDER_PENDING`); o painel lista as seções e abre o editor (RN-LGL-17). Na prática o bloqueio nasce em DOC-10; aqui é conferido de novo.
- **FA-03 — Favorável com ressalvas sem ressalva registrada:** 422 `LEGAL_RESERVATION_REQUIRED`; o diálogo leva ao registro de ressalva (RN-LGL-18).
- **FA-04 — Favorável com ressalva `OPEN`:** 422 `LEGAL_RESERVATION_INCONSISTENT`; escolher "Favorável com ressalvas" ou atender/registrar a ressalva (RN-LGL-61).
- **FA-05 — Ementa com dados sigilosos:** com orçamento sigiloso no processo, ementa contendo valor monetário é recusada com 422 `CONCLUSION_SUMMARY_CONFIDENTIAL` (RN-LGL-62).
- **FA-06 — Análise retomada após diligência:** a conclusão da rodada 2 vincula a versão do parecer da rodada 2; `LegalReviewDocument` da rodada 1 permanece intocado (RN-LGL-09, RN-LGL-13).
- **FA-07 — Segregação ou não designado:** 403 `LEGAL_REVIEW_SEGREGATION` ou `NOT_LEGAL_REVIEW_ASSIGNEE`; a ação fica oculta/desabilitada com o motivo (RN-LGL-10, POL-19).
- **FA-08 — Concluir já concluída:** 409 `INVALID_STATE`; reenvio com a mesma `Idempotency-Key` devolve a resposta original (RN-LGL-64).
- **FA-09 — Parecer revisado depois de concluído:** o parecer finalizado e a análise concluída são imutáveis; corrigir exige nova análise (processo devolvido a `JURIDICO` após a conclusão — DEC-196), nunca edição (RN-LGL-65).
- **FA-10 — Provedor `legalReview.*` indisponível:** a regra de saída é avaliada como não satisfeita (falha fechada — RN-WF2-84); a conclusão em si já foi gravada e a UI orienta tentar encaminhar de novo (RN-LGL-66).

## Regras de negócio
- **RN-LGL-09** — A análise considera as **versões exatas** dos documentos; `LegalReviewDocument` é gravado ao abrir cada rodada, **completado na conclusão** (versão do parecer) e imutável (DEC-199).
- **RN-LGL-10** — Segregação: quem elaborou o processo ou seus documentos não analisa; concluir exige `LEGAL_REVIEW_CONCLUDE` cobrindo o processo e ser o `assigneeId` ou o titular/substituto da unidade jurídica da etapa (POL-19).
- **RN-LGL-11** — Há seis situações do produto (`PENDING`, `IN_REVIEW`, `DILIGENCE`, `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`), mais `WAIVED` e `CANCELED`; as conclusivas e `WAIVED` são finais e a análise concluída é imutável (DEC-199).
- **RN-LGL-13** — A análise é retomada, não recriada, quando o processo volta a `JURIDICO`: rodada + 1; a conclusão vale para a rodada corrente (DEC-196, DEC-199).
- **RN-LGL-16** — Concluir exige o parecer `FINALIZED`, ementa sem dados sigilosos e a situação conclusiva escolhida por pessoa com `LEGAL_REVIEW_CONCLUDE`; nenhuma regra, IA ou integração preenche `status` (DEC-199, DEC-202).
- **RN-LGL-17** — Concluir exige também que todas as seções geradas por IA estejam revisadas (US-122) (DEC-202).
- **RN-LGL-18** — `FAVORABLE_WITH_RESERVATIONS` exige ao menos uma ressalva; `ADDRESSED` exige a resposta e `RISK_ACCEPTED` exige motivação da autoridade (DEC-199).
- **RN-LGL-19** — O parecer não é vinculante: `UNFAVORABLE` não bloqueia por si; prosseguir exige motivação da autoridade na aprovação seguinte, como regra `WARNING` com reconhecimento registrado (DEC-199, ADR-008).
- **RN-LGL-60** *(nova)* — A **situação** enviada em LGL-19 só aceita `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS` ou `UNFAVORABLE`, sem valor padrão no formulário nem na API; outro valor (`WAIVED`, `CANCELED`, `IN_REVIEW`…) ou ausência responde 422 `VALIDATION_ERROR`. A **ementa** (`conclusionSummary`) tem de 20 a 1.000 caracteres, texto puro (sem HTML), e é gravada como enviada (aparada nas pontas).
- **RN-LGL-61** *(nova)* — Coerência com as ressalvas: `FAVORABLE_WITH_RESERVATIONS` exige ≥ 1 ressalva registrada (qualquer situação, RN-LGL-18); `FAVORABLE` não pode ser concluída com ressalva `OPEN` (`LEGAL_RESERVATION_INCONSISTENT`); `UNFAVORABLE` aceita ressalvas. A contagem `reservationsCount` do evento é o total registrado na conclusão.
- **RN-LGL-62** *(nova)* — Sigilo da ementa: quando o orçamento do processo é sigiloso (DEC-030, POL-09), a ementa não pode conter valor monetário (padrão `R$` ou número com formato de moeda) nem as palavras-chave de valor da dotação; a API recusa com `CONCLUSION_SUMMARY_CONFIDENTIAL`. A ementa nunca entra em evento, notificação, log ou prompt de IA com valor; a notificação e o evento levam só `outcome` e rótulos (DEC-030).
- **RN-LGL-63** *(nova)* — Vínculo de versão: `opinionDocumentVersionId` é a versão `FINALIZED` **corrente** de `opinionDocumentId` no momento do commit; se houver mais de um `PARECER_JURIDICO` no processo (tipo com múltiplos), vale o apontado por `opinionDocumentId` (definido em LGL-20, US-154). A versão ganha uma linha em `LegalReviewDocument` (`documentTypeCode = PARECER_JURIDICO`, `round = currentRound`), sem alterar as linhas do snapshot das versões analisadas.
- **RN-LGL-64** *(nova)* — Atomicidade e idempotência: a conclusão (campos, `LegalReviewDocument`, auditoria, timeline, outbox) é uma transação única com `SELECT … FOR UPDATE` na análise; `If-Match` com ETag da análise e `Idempotency-Key` são obrigatórios; duas conclusões simultâneas resultam em uma 200 e uma 409 `INVALID_STATE`; reenvio com a mesma chave devolve a resposta original com `Idempotent-Replayed: true`.
- **RN-LGL-65** *(nova)* — Imutabilidade: um *trigger* do banco rejeita `UPDATE` em `legal_reviews` com `status` conclusivo (exceto os campos de auditoria técnica permitidos em migração controlada) e `INSERT/UPDATE/DELETE` em `legal_review_documents` e `legal_review_reservations` que contradigam o estado final; `ADDRESSED` e `RISK_ACCEPTED` de ressalvas continuam possíveis (US-154, POL-23) porque não alteram o ato concluído, e são registrados em `LegalReviewReservation`, não em `LegalReview`.
- **RN-LGL-66** *(nova)* — Provedor `legalReview.*` (`LegalReviewRuleContextContributor`, US-129): `exists` (há análise vigente ou concluída do processo), `status`, `concluded` (verdadeiro em `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`, `WAIVED`), `round`, `openReservations` (contagem `OPEN`), `waived`, `outdatedDocuments` (typeCodes cujo documento ganhou versão nova depois da conclusão, comparando com `LegalReviewDocument`). Lê só `LegalReviewFacade` em uma consulta, respeita o tempo de 2 s por namespace e falha fechada.
- **RN-LGL-67** *(nova)* — Regras padrão do workflow (a publicar com a versão padrão — US-130): saída de `JURIDICO` = `legalReview.concluded = true` (`BLOCKING`); avisos `WARNING` na saída de `CONTROLE_INTERNO` e na `AUTORIZACAO_LICITACAO` para `legalReview.status = UNFAVORABLE`, `legalReview.openReservations > 0` e `legalReview.outdatedDocuments` não vazio. Esta story fornece os fatos; a decisão com motivação (≥ 50) e o reconhecimento são da etapa de autorização (POL-23).
- **RN-LGL-68** *(nova)* — Concluir nunca move o processo: a regra de saída é satisfeita e o encaminhamento segue a tramitação do MVP 1 (US-041/047), inclusive o SLA da etapa (US-189/191). Se a análise for `CANCELED` ou o processo estiver `SUSPENDED`, concluir é recusado (`INVALID_STATE`).

## Campos
| Campo (UI) | Campo técnico | Tipo | Obrigatório | Regras | Padrão/origem |
|---|---|---|---|---|---|
| Situação conclusiva | `status` | enum | Sim | `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE` (RN-LGL-60) | **sem padrão** — escolha humana |
| Ementa do parecer | `conclusionSummary` | texto (≤ 1.000) | Sim | 20..1.000, texto puro, sem valor sigiloso (RN-LGL-60/62) | em branco |
| *(saída)* Parecer vinculado | `opinionDocumentId`, `opinionDocumentVersionId` | uuid | — | versão `FINALIZED` corrente (RN-LGL-63) | derivado |
| *(saída)* Concluída em / por | `concludedAt`, `concludedById` | timestamptz / uuid | — | imutáveis | sistema |
| *(saída)* Rodada | `round` | smallint | — | `currentRound` na conclusão | sistema |
| *(saída)* Ressalvas | `reservationsCount`, `openReservationsCount` | inteiro | — | RN-LGL-61 | derivado |
| *(saída)* Versões analisadas | `documents[]` (`typeCode`, `versionNumber`, `round`) | lista | — | `LegalReviewDocument` | derivado |
| *(cabeçalho)* Chave de idempotência / ETag | `Idempotency-Key`, `If-Match` | texto | Sim | RN-LGL-64 | gerado pelo front |

## Validações
| # | Validação | Camada | Mensagem ao usuário | Código de erro |
|---|---|---|---|---|
| V-01 | `status` ausente ou fora das três situações conclusivas | Front + API (Zod) | "Escolha a situação conclusiva do parecer." | `VALIDATION_ERROR` |
| V-02 | `conclusionSummary` com menos de 20 ou mais de 1.000 caracteres | Front + API (Zod) | "A ementa deve ter de 20 a 1.000 caracteres." | `VALIDATION_ERROR` |
| V-03 | Ementa com valor monetário em processo de orçamento sigiloso | API | "A ementa não pode conter valores do orçamento sigiloso. Remova os valores e tente de novo." | `CONCLUSION_SUMMARY_CONFIDENTIAL` |
| V-04 | Análise fora de `IN_REVIEW` (inclui já concluída, dispensada, em diligência, cancelada) | API | "Esta análise não pode ser concluída no estado atual." | `INVALID_STATE` |
| V-05 | Parecer inexistente ou fora de `FINALIZED` | API | "Finalize o parecer antes de concluir a análise." | `LEGAL_OPINION_NOT_FINALIZED` |
| V-06 | Seção gerada por IA sem revisão ou com `[a confirmar]` pendente | API | "Revise as seções geradas por IA antes de concluir." | `DOCUMENT_INCOMPLETE` (`SECTION_AI_REVIEW_PENDING`, `SECTION_PLACEHOLDER_PENDING`) |
| V-07 | `FAVORABLE_WITH_RESERVATIONS` sem ressalva registrada | Front + API | "Registre ao menos uma ressalva para concluir como favorável com ressalvas." | `LEGAL_RESERVATION_REQUIRED` |
| V-08 | `FAVORABLE` com ressalva `OPEN` | API | "Há ressalvas em aberto. Conclua como favorável com ressalvas ou resolva as ressalvas." | `LEGAL_RESERVATION_INCONSISTENT` |
| V-09 | Usuário sem segregação (autor, criador, lotado na unidade solicitante) | API | "Você não pode concluir uma análise de processo que elaborou ou em que atua como requisitante." | `LEGAL_REVIEW_SEGREGATION` |
| V-10 | Usuário que não é o designado nem titular/substituto da unidade jurídica | API | "Apenas o procurador designado ou o titular da unidade jurídica pode concluir esta análise." | `NOT_LEGAL_REVIEW_ASSIGNEE` |
| V-11 | `If-Match` ausente ou divergente | API | "A análise foi alterada. Recarregue para continuar." | `PRECONDITION_REQUIRED` / `VERSION_CONFLICT` |
| V-12 | `Idempotency-Key` ausente ou reutilizada com corpo diferente | API | "Esta chave já foi usada em outra solicitação." | `IDEMPOTENCY_KEY_REUSED` |

## Permissões
- **Permissão:** `LEGAL_REVIEW_CONCLUDE` (risco `H`) com escopo que cubra o processo; leitura do resultado por `LEGAL_REVIEW_VIEW` (SCR-019) ou `PROCESS_VIEW` (parecer concluído visível como os demais documentos).
- **Políticas:** POL-19 (segregação e designação), POL-24 (o rascunho do parecer só é lido por quem conduz; o finalizado é público ao processo), POL-23 (efeitos na autorização), DEC-024 (visibilidade), DEC-030/POL-09 (sigilo).
- **MFA:** exigido conforme `security.mfaPolicy` por ser permissão `H` (POL-14); sem MFA válido, 403 `MFA_REQUIRED`.
- **Sem permissão:** a ação "Concluir análise" fica oculta sem `LEGAL_REVIEW_CONCLUDE` e desabilitada com o motivo quando falha a segregação ou a designação; a API responde 403 `PERMISSION_DENIED` / `LEGAL_REVIEW_SEGREGATION` / `NOT_LEGAL_REVIEW_ASSIGNEE` e grava `access.denied`.

## Eventos gerados
| Evento | Routing key | Quando | Observação |
|---|---|---|---|
| `LegalReviewConcluded` | `legal_review.concluded` | Commit de LGL-19 | `legalReviewId`, `status`, `round`, `opinionDocumentVersionId`, `reservationsCount`; sem ementa nem texto; projeta `LEGAL_REVIEW_CONCLUDED` na timeline; consumidores: notificação, auditoria e avaliação da regra de saída |
| `DocumentFinalized` (nome do produto `LegalOpinionIssued`) | `document.finalized.parecer_juridico` | Finalização do parecer (DOC-10, US-154), **antes** da conclusão | Não é republicado aqui; a conclusão o referencia por `opinionDocumentVersionId` e a timeline mostra o código do documento (ver lacuna 2) |

## Notificações
| Tipo | Destinatários | Canais | Quando |
|---|---|---|---|
| `LEGAL_REVIEW_CONCLUDED` | Criador do processo; responsável da etapa seguinte; titular da secretaria solicitante | in-app + e-mail (padrão) | `LegalReviewConcluded` (corpo com situação e código do parecer; nunca ementa nem valores) |

## Critérios de aceite em Gherkin
```gherkin
Feature: Concluir a análise jurídica com a situação conclusiva

  Background:
    Given que o tenant "Prefeitura A" está ativo com o workflow padrão v2
    And o processo "0045/2026" está na etapa "JURIDICO" com a análise na rodada 2 em "IN_REVIEW"
    And "Dr. André" tem vínculo ativo no perfil "JURIDICO", com "LEGAL_REVIEW_MANAGE" e "LEGAL_REVIEW_CONCLUDE" no processo, é o procurador designado e não atuou como autor nem requisitante
    And o parecer "PJ 0007/2026" está "FINALIZED" na versão 3, sem seções de IA pendentes de revisão
    And "Carla Mendes" criou o processo na "Secretaria de Administração"

  Scenario: [Sucesso] Concluir como favorável com ressalvas
    Given que existe uma ressalva "OPEN" sobre o edital registrada na análise
    When "Dr. André" concluir com a situação "FAVORABLE_WITH_RESERVATIONS" e a ementa "Favorável à contratação, condicionada à correção da cláusula de reajuste do edital."
    Then a API deve responder 200 com a análise em "FAVORABLE_WITH_RESERVATIONS", "opinionDocumentVersionId" da versão 3 e "concludedById" de "Dr. André"
    And "LegalReviewDocument" da rodada 2 deve conter o parecer na versão 3 e as linhas do snapshot da rodada 1 devem permanecer intactas
    And a regra de saída "legalReview.concluded" da etapa "JURIDICO" deve estar satisfeita e o processo não deve ter sido movido
    And "legalReview.openReservations" deve ser 1
    And deve gerar registro de auditoria "legal_review.conclude" com "status", "round" e "reservationsCount"
    And deve gerar o evento "LegalReviewConcluded" e a notificação "LEGAL_REVIEW_CONCLUDED" para "Carla Mendes" e para o responsável da etapa seguinte

  Scenario: [Sucesso] Concluir como desfavorável não bloqueia o processo
    When "Dr. André" concluir com a situação "UNFAVORABLE" e uma ementa válida
    Then a análise deve ficar "UNFAVORABLE" e "legalReview.concluded" deve ser verdadeiro
    And o processo deve poder ser encaminhado normalmente
    And a etapa "AUTORIZACAO_LICITACAO" deve passar a exibir o aviso "WARNING" de parecer desfavorável a ser reconhecido

  Scenario: [Sucesso] Favorável sem ressalvas
    Given que a análise não tem ressalvas registradas
    When "Dr. André" concluir com a situação "FAVORABLE" e uma ementa válida
    Then a análise deve ficar "FAVORABLE" com "reservationsCount" igual a 0
    And o evento "LegalReviewConcluded" deve ser gerado sem "reservationsCount" maior que 0

  Scenario: [Sucesso] A análise concluída é imutável
    Given que a análise foi concluída como "FAVORABLE"
    When qualquer usuário tentar alterar a situação, a ementa ou a versão do parecer por API ou por SQL direto
    Then a alteração deve ser recusada pela API com 409 "INVALID_STATE" e pelo banco por violação do gatilho de imutabilidade

  Scenario: [Validação] Parecer não finalizado, ementa inválida e ressalva ausente
    Given que o parecer "PJ 0007/2026" está "DRAFT"
    When "Dr. André" concluir com a situação "FAVORABLE" e uma ementa válida
    Then a API deve responder 422 com código "LEGAL_OPINION_NOT_FINALIZED"
    Given que o parecer está "FINALIZED" e a análise não tem ressalvas
    When "Dr. André" concluir com a situação "FAVORABLE_WITH_RESERVATIONS"
    Then a API deve responder 422 com código "LEGAL_RESERVATION_REQUIRED"
    When "Dr. André" concluir com a situação "FAVORABLE" e a ementa "curta"
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "conclusionSummary"
    When "Dr. André" concluir sem informar a situação
    Then a API deve responder 422 com código "VALIDATION_ERROR" no campo "status" e nada deve ser gravado

  Scenario: [Validação] Seções de IA sem revisão e ementa com valor sigiloso
    Given que o parecer tem a seção "ANALYSIS" gerada por IA sem revisão humana
    When "Dr. André" concluir a análise
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e a violação "SECTION_AI_REVIEW_PENDING" em "ANALYSIS"
    Given que o orçamento do processo é sigiloso
    When "Dr. André" concluir com a ementa "Favorável para a contratação estimada em R$ 1.250.000,00."
    Then a API deve responder 422 com código "CONCLUSION_SUMMARY_CONFIDENTIAL" e a ementa não deve ser gravada

  Scenario: [Permissão] Sem permissão, sem segregação ou sem designação
    Given que "Bruno Lopes" não tem "LEGAL_REVIEW_CONCLUDE"
    When "Bruno Lopes" chamar "POST /legal-reviews/{id}/conclude"
    Then a API deve responder 403 com código "PERMISSION_DENIED" e gerar o registro de auditoria "access.denied"
    Given que "Dra. Marta" tem "LEGAL_REVIEW_CONCLUDE", mas é lotada na unidade solicitante do processo
    When "Dra. Marta" tentar concluir
    Then a API deve responder 403 com código "LEGAL_REVIEW_SEGREGATION"
    Given que "Dra. Lúcia" tem a permissão, mas não é a designada nem titular da unidade jurídica
    When "Dra. Lúcia" tentar concluir
    Then a API deve responder 403 com código "NOT_LEGAL_REVIEW_ASSIGNEE"
    Given que a política de MFA exige segundo fator e a sessão de "Dr. André" não o validou
    When "Dr. André" tentar concluir
    Then a API deve responder 403 com código "MFA_REQUIRED" e nada deve ser gravado

  Scenario: [Tenant incorreto] Análise de outro tenant
    Given que existe a análise "0031/2026" no tenant "Prefeitura B"
    When "Dr. André" chamar "POST /legal-reviews/{id-da-Prefeitura-B}/conclude"
    Then a API deve responder 404 com código "NOT_FOUND"
    And nada do tenant "Prefeitura B" deve ser lido nem alterado
    And o provedor "legalReview" do tenant "Prefeitura A" não deve considerar análises da "Prefeitura B"

  Scenario: [Duplicidade] Reenvio da conclusão com a mesma chave e conclusão repetida
    Given que "Dr. André" concluiu a análise com a chave "K1" e recebeu 200
    When a mesma requisição for reenviada com a chave "K1"
    Then a API deve responder 200 com o mesmo corpo e o cabeçalho "Idempotent-Replayed: true"
    And deve existir uma única auditoria "legal_review.conclude" e um único evento "LegalReviewConcluded"
    When "Dr. André" enviar nova conclusão com a chave "K2"
    Then a API deve responder 409 com código "INVALID_STATE"

  Scenario: [Concorrência] Conclusão simultânea com diligência ou com outra conclusão
    When "Dr. André" concluir a análise ao mesmo tempo em que a titular "Dra. Beatriz" concluir com outra situação
    Then exatamente uma conclusão deve responder 200 e a outra 409 com código "INVALID_STATE"
    And a situação gravada deve ser a da conclusão vencedora, sem mistura de campos
    Given que "Dr. André" abriu o diálogo com a análise na versão "3" do ETag
    When a análise for alterada por outra ação (nova ressalva registrada) e "Dr. André" enviar com "If-Match" antigo
    Then a API deve responder 412 com código "VERSION_CONFLICT" e o painel deve recarregar as ressalvas

  Scenario: [Falha de banco] Banco indisponível durante a transação de conclusão
    Given que o banco de dados fica indisponível durante a transação de "POST /legal-reviews/{id}/conclude"
    When "Dr. André" confirmar a conclusão
    Then a API deve responder 503 com código "DEPENDENCY_UNAVAILABLE" e cabeçalho "Retry-After"
    And a análise deve continuar "IN_REVIEW", sem auditoria, evento, timeline nem "LegalReviewDocument" novo

  Scenario: [Falha de integração] Relay do outbox e provedor de regras indisponíveis
    Given que o relay do outbox está indisponível
    When "Dr. André" concluir a análise com sucesso
    Then a API deve responder 200 e o evento "LegalReviewConcluded" deve permanecer "PENDING" no outbox até o relay voltar
    Given que o provedor do namespace "legalReview" excede o tempo de 2 segundos
    When o responsável tentar encaminhar o processo
    Then a regra "legalReview.concluded" deve ser avaliada como não satisfeita com erro "RULE_CONTEXT_UNAVAILABLE"
    And a análise concluída deve permanecer inalterada
```

## Casos de erro
| Situação | HTTP | Código | Mensagem (pt-BR) | Comportamento da UI |
|---|---|---|---|---|
| Situação ou ementa inválidas | 422 | `VALIDATION_ERROR` | "Revise a situação conclusiva e a ementa (20 a 1.000 caracteres)." | Marca o campo |
| Ementa com valor sigiloso | 422 | `CONCLUSION_SUMMARY_CONFIDENTIAL` | "A ementa não pode conter valores do orçamento sigiloso." | Destaca a ementa |
| Parecer não finalizado | 422 | `LEGAL_OPINION_NOT_FINALIZED` | "Finalize o parecer antes de concluir a análise." | Atalho "Abrir o parecer" |
| Seção de IA sem revisão | 422 | `DOCUMENT_INCOMPLETE` | "Revise as seções geradas por IA antes de concluir." | Lista as seções com link |
| Ressalva obrigatória ausente | 422 | `LEGAL_RESERVATION_REQUIRED` | "Registre ao menos uma ressalva para concluir como favorável com ressalvas." | Atalho "Registrar ressalva" |
| Ressalva aberta com favorável | 422 | `LEGAL_RESERVATION_INCONSISTENT` | "Há ressalvas em aberto. Conclua como favorável com ressalvas ou resolva as ressalvas." | Realça as ressalvas |
| Sem permissão | 403 | `PERMISSION_DENIED` | "Você não tem permissão para concluir esta análise." | Oculta a ação |
| Segregação | 403 | `LEGAL_REVIEW_SEGREGATION` | "Você não pode concluir uma análise de processo que elaborou ou em que atua como requisitante." | Desabilita com o motivo |
| Não designado | 403 | `NOT_LEGAL_REVIEW_ASSIGNEE` | "Apenas o procurador designado ou o titular da unidade jurídica pode concluir esta análise." | Desabilita com o motivo |
| MFA necessário | 403 | `MFA_REQUIRED` | "Confirme sua identidade com o segundo fator para continuar." | Abre o desafio de MFA e repete a chamada |
| Análise inexistente ou de outro tenant | 404 | `NOT_FOUND` | "Análise jurídica não encontrada." | Volta à fila |
| Estado incompatível / já concluída | 409 | `INVALID_STATE` | "Esta análise não pode ser concluída no estado atual." | Recarrega o painel |
| `If-Match` divergente | 412 | `VERSION_CONFLICT` | "A análise foi alterada. Recarregue para continuar." | Recarrega e mantém o texto da ementa |
| `If-Match` ausente | 428 | `PRECONDITION_REQUIRED` | "Recarregue a análise para continuar." | Recarrega |
| Chave reutilizada com corpo diferente | 422 | `IDEMPOTENCY_KEY_REUSED` | "Esta chave já foi usada em outra solicitação." | Gera nova chave |
| Banco ou Redis indisponível | 503 | `DEPENDENCY_UNAVAILABLE` | "Não foi possível concluir agora. Tente novamente em instantes." | Mantém o diálogo; respeita `Retry-After` |

## Dependências
- **Stories:** US-129 (contrato e mecanismo do `RuleContext` v2 — esta story publica o provedor `legalReview.*`), US-154 (parecer `PARECER_JURIDICO`, finalização e ressalvas). Indiretas: US-149/US-152 (fila, abertura e snapshot por rodada), US-153 (diligência e rodadas), US-122 (revisão de seções de IA), US-065 (DOC-10), US-041/047 (encaminhamento), US-130 (regras padrão da v2), US-189/US-191 (SLA e pausa), US-193 (notificações), EP-027 (autorização, onde o `WARNING` é reconhecido).
- **Decisões/ADRs:** DEC-018, DEC-024, DEC-030, DEC-196, DEC-199, DEC-202, DEC-205; ADR-008 (avisos e reconhecimento), ADR-015 (`RuleContext` v2).
- **Configurações:** `security.mfaPolicy`. Nenhuma chave nova `legalReview.*` é necessária.
- **Lacunas nas fontes canônicas:**
  1. **Códigos de erro novos:** `LEGAL_OPINION_NOT_FINALIZED`, `LEGAL_RESERVATION_REQUIRED`, `LEGAL_RESERVATION_INCONSISTENT` e `CONCLUSION_SUMMARY_CONFIDENTIAL` não constam de `permissions.md`/`api.md`; `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE` e `DOCUMENT_DRAFT_RESTRICTED` constam (POL-19/24). A consolidar no `api.md` do card 9.
  2. **`LegalOpinionIssued`:** `events.md` define o nome como `DocumentFinalized` do `PARECER_JURIDICO`, emitido na finalização (DOC-10); a feature agrupa-o com a conclusão. Esta story não o republica — **dúvida de produto** se a timeline deve mostrá-lo à parte.
  3. **Regras de `FAVORABLE` × ressalva `OPEN` e do formato da ementa (RN-LGL-60/61/62)** são novas (faixa 60..79) e precisam de confirmação do piloto.
  4. **Regras `WARNING` da autorização** (RN-LGL-67) dependem da versão padrão v2 (US-130) e da story de autorização do EP-027; não há ID de regra no `entities.md` para o conteúdo exato.
  5. **LGL-02 e LGL-24** devolvem a análise; os campos aditivos (`documents[]`, `reservationsCount`, `conclusionChecklist`) não estão no catálogo de API do MVP 2.
  6. **Nova `LegalReview` após conclusão** (devolução do Controle Interno): `entities.md` prevê o caso, mas não detalha se o parecer anterior é entrada da nova análise; tratado em US-152.

## Impacto técnico
- **Imutabilidade por trigger:** a migração M2-15 em diante já prevê o trigger de `legal_reviews`; a story acrescenta os testes de contrato (SQL direto) e precisa que o trigger permita só campos técnicos controlados.
- **Provedor `legalReview.*`:** consulta única agregada (status, rodada, contagem de ressalvas `OPEN`, `outdatedDocuments` por comparação com `LegalReviewDocument`); cache por requisição do `RuleContext` (RN-WF2-82); meta de p95 ≤ 50 ms por avaliação.
- **Atomicidade:** nenhuma chamada de rede dentro da transação; o outbox leva `LegalReviewConcluded`; o PDF do parecer não é gerado aqui (DOC-10 já o fez).
- **Compatibilidade:** o campo `status` conclusivo sai da UI apenas por escolha humana; testes verificam que nenhum caminho de IA, regra ou *job* escreve `status`.
- **Sigilo:** a verificação da ementa usa a mesma biblioteca de detecção de valores do `ContextSanitizer` da IA, mas aqui é regra de domínio (não depende de `ai.enabled`).

## Backend
- **Módulo(s):** `legal-review` (dono: `ConcludeLegalReviewCommand`, `LegalReviewRuleContextContributor`, `LegalReviewFacade`), `document` (leitura da versão e do estado do parecer), `workflow` (avaliação de regras), `process`, `timeline`, `notification`, `audit`, `access`.
- **Casos de uso:** `ConcludeLegalReviewCommand` (LGL-19); `GetLegalReviewQuery` (LGL-02/LGL-24, estendidos com `conclusionChecklist`).
- **Domínio:** `LegalReview.conclude(status, summary, actor)` (invariantes de §4.3 de `entities.md`); `LegalReviewConclusionPolicy` (parecer, IA revisada, ressalvas, ementa); `LegalReviewDocument` (completar).
- **Integrações internas:** `DocumentFacade.getFinalizedVersion/hasPendingAiReview` (leitura), `AuthorizationService.assertCan('LEGAL_REVIEW_CONCLUDE', { processId })` com POL-19, `ConfidentialBudgetGuard`, `OutboxWriter`, `AuditService`, `TimelineProjector`, `IdempotencyService`.
- **Transação:** bloqueio da análise → validações → atualização + `LegalReviewDocument` → auditoria → timeline → outbox → commit; avaliação de regras fora da transação.

## Frontend
- **Tela(s):** SCR-019 (`/juridico/[reviewId]`); SCR-006 (`/processos/[id]`, situação da análise); SCR-015 (leitura do parecer pela autoridade).
- **Componentes:** `LegalReviewPanel`, `ConclusionChecklist`, `ConcludeLegalReviewDialog` (RadioGroup de situação sem pré-seleção, textarea da ementa com contador, resumo do vínculo), `LegalReviewOutcomeBadge`, `ReservationList`, `MfaChallengeDialog`.
- **Estados:** carregando (skeleton); lista de verificação incompleta (ação desabilitada com motivo); diálogo; enviando; concluída (somente leitura); erro por código traduzido; vazio de ressalvas.
- **Acessibilidade e responsividade:** opções de situação em grupo de rádio com rótulo e descrição; erros anunciados por `aria-live`; foco volta ao selo da situação após concluir; selos de situação por texto e ícone, não só cor; diálogo em tela cheia abaixo de 768 px.

## Banco de dados
- **Tabelas:** `legal_reviews` (update), `legal_review_documents` (insert), `legal_review_reservations` (leitura), `documents`/`document_versions` (leitura), `audit_logs`, `outbox_events`, `timeline_entries`, `notifications`.
- **Migrações:** nenhuma nova além das de `LegalReview` (M2-15 em diante); inclui, se ausente, o *trigger* de imutabilidade e os *checks* de §4.3 de `entities.md`.
- **Índices/constraints relevantes:** *check* `status` conclusivo ⇒ `concluded_at`, `opinion_document_version_id`, `conclusion_summary` não nulos; único parcial de uma análise aberta por processo; `(tenant_id, legal_review_id, round, document_id)` em `legal_review_documents`.

## API
| ID | Método | Rota | Request (resumo) | Response (resumo) | Códigos |
|---|---|---|---|---|---|
| `LGL-19` | POST | `/api/v1/legal-reviews/{id}/conclude` | `{ status, conclusionSummary }` + `If-Match` + `Idempotency-Key` | `200 { data: LegalReview }` (concluída, com `documents[]`) + `ETag` | 200, 401, 403, 404, 409, 412, 422, 428, 503 |
| `LGL-02` | GET | `/api/v1/legal-reviews/{id}` | path `id` | painel com `conclusionChecklist` e situação final | 200, 403, 404 |
| `LGL-24` | GET | `/api/v1/processes/{id}/legal-review` | path `id` | análise vigente (para SCR-006 e SCR-015) | 200, 403, 404 |
| `LGL-16` | GET | `/api/v1/legal-reviews/{id}/reservations` | — | ressalvas e situações (lista exibida no diálogo) | 200, 403, 404 |
| `DOC-10` | POST | `/api/v1/documents/{id}/finalize` | MVP 1 | finaliza o parecer (pré-condição) | 200, 403, 404, 409, 412, 422 |

## Logs
- `info` `legal_review.concluded` — `legalReviewId`, `processId`, `status`, `round`, `reservationsCount`, `durationMs`, `correlationId`.
- `warn` `legal_review.conclude_rejected` — `legalReviewId`, `errorCode`; `warn` `idempotency.store_unavailable`; `warn` `rule_context.legal_review_slow`.
- `error` `legal_review.conclude_failed` — `errorCode`, causa resumida, `correlationId`.
- **Nunca logar:** ementa, texto do parecer ou das ressalvas, valores do orçamento sigiloso, nomes de pessoas.

## Auditoria
| Ação | Categoria | Quando | `changes` / `metadata` |
|---|---|---|---|
| `legal_review.conclude` | `WORKFLOW` | Commit de LGL-19 | `changes`: `status` (de `IN_REVIEW`), `opinionDocumentVersionId`; `metadata`: `round`, `reservationsCount`, `openReservationsCount`, `mfa`, `idempotencyKey`; sem ementa |
| `access.denied` | `ACCESS` | 403 em LGL-19 | `reasonCode` (`LEGAL_REVIEW_CONCLUDE`, `LEGAL_REVIEW_SEGREGATION`, `NOT_LEGAL_REVIEW_ASSIGNEE`), `legalReviewId` |

## Testes necessários
- **Unitários:** `LegalReviewConclusionPolicy` (situação, parecer, IA, ressalvas, ementa, sigilo); `LegalReview.conclude` e transições inválidas; `LegalReviewRuleContextContributor` (todas as situações, `outdatedDocuments`); detecção de valor na ementa.
- **Integração (Testcontainers):** transação completa (campos, `LegalReviewDocument`, auditoria, timeline, outbox); trigger de imutabilidade (SQL direto); rollback total na falha; regra de saída satisfeita após a conclusão; rodada 2 preservando a rodada 1.
- **API/contrato:** LGL-19 conforme `api.md` (ETag, `Idempotent-Replayed`, 428/412); `LegalReview` sem campo de ementa em eventos.
- **RBAC e multi-tenant:** `LEGAL_REVIEW_CONCLUDE` por perfil e escopo; POL-19 (autor, criador, lotado na unidade solicitante, não designado); MFA; análise e parecer de outro tenant → 404; teste novo na suíte `test/tenant-leak` (conclusão e provedor `legalReview`).
- **Concorrência:** duas conclusões simultâneas; conclusão × pedido de diligência × dispensa; `If-Match` desatualizado.
- **E2E (Playwright):** diligência → retomada → finalizar parecer → registrar ressalva → concluir com ressalvas → regra de saída satisfeita → aviso na autorização.
- **Acessibilidade/performance:** axe no diálogo e no painel; 360 px; p95 de LGL-19 ≤ 400 ms na suíte de performance (medido no endurecimento).

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
- [ ] Teste prova que nenhum caminho de IA, regra ou job grava a situação conclusiva (DEC-202)
- [ ] Trigger de imutabilidade coberto por teste de SQL direto
- [ ] Provedor `legalReview.*` registrado e coberto pelo teste de contrato dos provedores (US-129)

## Estimativa
**M** — um comando com muitas pré-condições (parecer, IA, ressalvas, ementa, segregação, MFA), vínculo imutável às versões, trigger e o provedor do `RuleContext`; o esforço está nas regras de coerência e nos testes de concorrência e imutabilidade.

## Prioridade
**P0** — sem a conclusão a etapa `JURIDICO` não é liberada (regra de saída padrão) e a fase preparatória não avança; é o ato central do art. 53.
