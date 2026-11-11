---
id: FT-074
title: "Análise, diligência e parecer"
epic: EP-025
mvp: 2
priority: P0
stories: [US-152, US-153, US-154, US-155, US-156]
status: Especificada
---

# FT-074 — Análise, diligência e parecer

## Título
Análise, diligência e parecer

## Épico
EP-025 — Jurídico

## Descrição
O procurador inicia a análise (`IN_REVIEW`) sobre as **versões exatas** dos documentos do processo (DFD, ETP, mapa de riscos, pesquisa de preços, TR, edital e minuta do contrato), gravadas em `LegalReviewDocument` a cada rodada (US-152). Se faltar informação, pede diligência: o processo é devolvido (`RETURN`) para uma etapa já percorrida e a análise fica em `DILIGENCE`, com prazo de atendimento e lembretes. Quando o processo volta a `JURIDICO`, a mesma análise é **retomada** em nova rodada, com comparação entre as versões (US-153).

O parecer é um documento `PARECER_JURIDICO` elaborado no editor, com ressalvas registradas como itens rastreáveis que as etapas seguintes veem (US-154). Concluir exige o parecer finalizado e a situação conclusiva escolhida pelo procurador: favorável, favorável com ressalvas ou desfavorável (US-155). O parecer é **não vinculante**. Hipóteses configuradas pelo órgão permitem **dispensar** a análise (art. 53, § 5º), registrada como `WAIVED` com a hipótese e a justificativa (US-156).

## Valor para o usuário e para o órgão
- O parecer fica preso às versões que foram de fato analisadas, o que elimina dúvida sobre "o que o jurídico viu".
- Diligências deixam de ser troca de e-mails: pedido, prazo, devolução e resposta ficam no processo.
- Ressalvas viram pendências rastreáveis até o atendimento ou o aceite do risco pela autoridade.

## Personas
- Jurídico / procurador (`JURIDICO`) — analisa, pede diligência, elabora o parecer, conclui e dispensa.
- Planejamento e Compras (`PLANEJAMENTO`, `COMPRAS`) — atendem diligências e ressalvas.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — lê o parecer e motiva a decisão diante de `UNFAVORABLE`.
- Auditor e controle interno (`AUDITOR`, `CONTROLE_INTERNO`) — rastreiam versões, diligências e ressalvas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-152 ⏳ | Conduzir a análise jurídica sobre versões exatas | P0 | M | US-066, US-149 |
| US-153 ⏳ | Pedir diligência e retomar a análise | P0 | L | US-048, US-066, US-152 |
| US-154 ⏳ | Elaborar o parecer jurídico e registrar ressalvas | P0 | M | US-065, US-110, US-152 |
| US-155 ⏳ | Concluir a análise com a situação conclusiva | P0 | M | US-129, US-154 |
| US-156 ⏳ | Dispensar a análise jurídica por hipótese configurada | P0 | M | US-149, US-151 |

## Escopo
- Início da análise (`PENDING` para `IN_REVIEW`); snapshot das versões vigentes em `LegalReviewDocument` (rodada 1); consulta e comparação das versões.
- Pedido de diligência (texto de 20 a 10.000 caracteres, etapa de retorno, prazo sugerido) com `RETURN` do processo e pausa do prazo da etapa; lembretes antes do vencimento.
- Retomada na volta a `JURIDICO`: mesma `LegalReview`, `currentRound` + 1, novo snapshot e comparação com a rodada anterior; resposta de quem atendeu.
- Documento `PARECER_JURIDICO` (template do órgão, ciclo de vida da DEC-018) e rascunho restrito a quem o conduz (POL-24).
- Ressalvas (`LegalReviewReservation`): descrição, documento afetado, situação `OPEN`, `ADDRESSED` ou `RISK_ACCEPTED`.
- Conclusão: parecer `FINALIZED`, ementa, situação conclusiva e versão do parecer vinculada; `FAVORABLE_WITH_RESERVATIONS` exige ao menos uma ressalva.
- Dispensa (`PENDING` para `WAIVED`) com hipótese ativa, condição verdadeira e justificativa; satisfaz a regra de saída de `JURIDICO`.
- Cancelamento da análise quando o processo ou o ramo é cancelado.

## Fora de escopo
- Fila, distribuição e configuração (FT-073); rascunho por IA (FT-075).
- Manifestação do Controle Interno (EP-026) e decisão da autoridade sobre o edital (EP-027).
- Assinatura eletrônica do parecer (MVP 3).
- Bloquear o processo por parecer desfavorável: a decisão da autoridade exige motivação, mas o parecer não vincula.

## Regras de negócio da feature
- RN-LGL-09 — A análise considera as **versões exatas** dos documentos; `LegalReviewDocument` é gravado ao abrir cada rodada, completado na conclusão e imutável (DEC-199).
- RN-LGL-10 — Segregação: quem elaborou o processo ou seus documentos não analisa; a análise exige `LEGAL_REVIEW_MANAGE` cobrindo o processo (POL-19).
- RN-LGL-11 — Há seis situações do produto (`PENDING`, `IN_REVIEW`, `DILIGENCE`, `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`), mais `WAIVED` e `CANCELED`; as conclusivas e `WAIVED` são finais e a análise concluída é imutável (DEC-199).
- RN-LGL-12 — Diligência devolve o processo (`RETURN`) para qualquer etapa já percorrida; a análise passa a `DILIGENCE` e o prazo da etapa `JURIDICO` fica pausado (DEC-196, DEC-205).
- RN-LGL-13 — A análise é **retomada**, não recriada, quando o processo volta a `JURIDICO`: rodada + 1, novo snapshot das versões e comparação com a rodada anterior (DEC-196, DEC-199).
- RN-LGL-14 — O prazo de atendimento da diligência segue `legalReview.diligenceDueBusinessDays`, com lembrete conforme `legalReview.diligenceReminderBusinessDays` (DEC-199).
- RN-LGL-15 — O parecer em rascunho só é lido por quem tem `LEGAL_REVIEW_MANAGE` cobrindo o processo e por `AUDITOR` com `AUDIT_VIEW`; os demais veem título e status (POL-24, `DOCUMENT_DRAFT_RESTRICTED`).
- RN-LGL-16 — Concluir exige o parecer `FINALIZED`, ementa sem dados sigilosos e a situação conclusiva escolhida por pessoa com `LEGAL_REVIEW_CONCLUDE`; nenhuma regra, IA ou integração preenche `status` (DEC-199, DEC-202).
- RN-LGL-17 — Concluir exige também que todas as seções geradas por IA estejam revisadas (US-122) (DEC-202).
- RN-LGL-18 — `FAVORABLE_WITH_RESERVATIONS` exige ao menos uma ressalva; `ADDRESSED` exige a resposta e `RISK_ACCEPTED` exige motivação da autoridade (DEC-199).
- RN-LGL-19 — O parecer não é vinculante: `UNFAVORABLE` não bloqueia por si; prosseguir exige motivação da autoridade na aprovação seguinte, como regra `WARNING` com reconhecimento registrado (DEC-199, ADR-008).
- RN-LGL-20 — A dispensa exige `LEGAL_REVIEW_WAIVE`, análise em `PENDING`, hipótese `LEGAL_WAIVER_HYPOTHESIS` ativa cuja condição seja verdadeira para o processo e justificativa de pelo menos 20 caracteres; em etapa marcada `isLegallyRequired` só vale se a hipótese a prevê (`LEGAL_WAIVER_NOT_APPLICABLE`) (POL-26, DEC-199).

## Telas
- SCR-019 — Jurídico: painel de análise (`/juridico/[reviewId]`).
- SCR-006 — Detalhe do processo: situação da análise, diligências e ressalvas.
- Editor do parecer (`PARECER_JURIDICO`) e SCR-015 — Detalhe da aprovação (leitura do parecer pela autoridade).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /legal-reviews/{id}/start` — iniciar a análise.
- `GET /legal-reviews/{id}/documents` — versões analisadas por rodada.
- `GET /legal-reviews/{id}/documents/compare?fromRound=&toRound=` — comparar rodadas.
- `POST /legal-reviews/{id}/diligences` — pedir diligência (devolve o processo).
- `POST /legal-review-diligences/{diligenceId}/answer` — registrar a resposta de quem atendeu.
- `GET /legal-reviews/{id}/reservations` e `POST /legal-reviews/{id}/reservations` — listar e registrar ressalvas.
- `PATCH /legal-review-reservations/{reservationId}` — atender ou aceitar o risco.
- `POST /legal-reviews/{id}/conclude` — concluir com a situação.
- `POST /legal-reviews/{id}/waive` — dispensar por hipótese.
- Endpoints do MVP 1 estendidos: `PUT /documents/{id}/sections/{sectionKey}` (DOC-05) e `POST /documents/{id}/finalize` (DOC-10) para `PARECER_JURIDICO`.

## Entidades
- `LegalReview`, `LegalReviewDocument`, `LegalReviewDiligence`, `LegalReviewReservation`.
- `Document` e `DocumentVersion` — parecer e versões analisadas.
- `ProcessMovement` — o `RETURN` da diligência.
- `CatalogItem` (`LEGAL_WAIVER_HYPOTHESIS`).

## Eventos
- `LegalReviewStarted` — início de cada rodada.
- `LegalReviewDiligenceRequested` — pedido (timeline, notificação, auditoria).
- `LegalReviewDiligenceReminderDue` — lembrete do prazo.
- `LegalReviewResumed` — retomada (timeline, notificação).
- `LegalReviewConcluded` — conclusão (timeline, notificação, auditoria); `DocumentFinalized` de `PARECER_JURIDICO` (`LegalOpinionIssued`).
- `LegalReviewWaived` — dispensa.
- `LegalReviewCanceled` — cancelamento.
- `LegalReservationResolved` — ressalva atendida ou risco aceito.

## Permissões
- `LEGAL_REVIEW_MANAGE` — iniciar, pedir diligência, editar o parecer e registrar ressalvas.
- `LEGAL_REVIEW_CONCLUDE` — escolher a situação conclusiva e concluir.
- `LEGAL_REVIEW_WAIVE` — dispensar (POL-26).
- `PROCESS_RETURN` — devolução na diligência.
- `PROCESS_VIEW` — leitura do parecer concluído.

## Dependências
- FT-073 (abertura e distribuição); EP-021 (etapa `JURIDICO`, `pauseSlaWhileReturned`, `RuleContext` v2 — US-129).
- US-048 (devolução), US-065 e US-066 (documentos e versões), US-110 (comentários).
- DEC-018 (ciclo de vida do documento) e US-122 (revisão de seções geradas por IA).

## Critérios de aceite da feature
```gherkin
Feature: Análise, diligência e parecer jurídico
  Scenario: Diligência, retomada e conclusão com ressalvas
    Given que a análise "0045/2026" está "IN_REVIEW" com as versões vigentes de DFD, ETP, TR e edital registradas na rodada 1
    When "Dr. André" pedir diligência sobre a pesquisa de preços, devolvendo o processo a "PESQUISA_PRECOS"
    Then a análise deve ficar "DILIGENCE" e o prazo da etapa jurídica deve ficar pausado
    When o processo voltar a "JURIDICO" com uma nova versão da pesquisa de preços
    Then a mesma análise deve ser retomada na rodada 2 com as versões novas e a comparação disponível
    When "Dr. André" finalizar o parecer, registrar uma ressalva sobre o edital e escolher "favorável com ressalvas"
    Then a análise deve ser concluída vinculada à versão do parecer
    And a ressalva deve ficar visível para a etapa seguinte como "OPEN"

  Scenario: Dispensa por hipótese configurada
    Given que existe a hipótese ativa "compras com minutas padronizadas" cuja condição é verdadeira para o processo "0052/2026"
    When "Dr. André", com "LEGAL_REVIEW_WAIVE", dispensar a análise informando a justificativa
    Then a análise deve ficar "WAIVED" com a hipótese e a justificativa registradas
    And a regra de saída da etapa "JURIDICO" deve estar satisfeita
```

## Métricas de sucesso
- Análise concluída em ≤ 10 dias úteis (mediana, sem o tempo de diligência).
- ≥ 75% das diligências atendidas no prazo sugerido.
- 100% dos pareceres vinculados às versões analisadas.

## Riscos
- Versão do documento muda durante a análise — snapshot por rodada e nova rodada obrigatória na retomada.
- Dispensa usada como atalho — hipótese configurada, condição verificada, justificativa e auditoria.
- Diligência sem atendimento — prazo sugerido, lembretes e visibilidade na timeline e na caixa de tarefas.
- Vazamento do rascunho do parecer — POL-24 e testes de autorização.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
