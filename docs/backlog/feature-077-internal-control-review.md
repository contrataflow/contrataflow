---
id: FT-077
title: "Manifestação do Controle Interno"
epic: EP-026
mvp: 2
priority: P0
stories: [US-159, US-160, US-161, US-162]
status: Especificada
---

# FT-077 — Manifestação do Controle Interno

## Título
Manifestação do Controle Interno

## Épico
EP-026 — Controle Interno

## Descrição
Painel da manifestação do Controle Interno sobre o processo (SCR-020), da abertura ao acompanhamento dos achados:
- **Abertura:** ao entrar na etapa `CONTROLE_INTERNO` nasce uma `InternalControlReview` `PENDING`, com o checklist publicado fixado e uma resposta `PENDING` por item. O painel traz a **visão de riscos** do processo: mapa de riscos e avisos `WARNING` superados com a ciência registrada (L-08), além do parecer jurídico vigente quando existir.
- **Análise:** o analista responde cada item (`COMPLIANT`, `NON_COMPLIANT` ou `NOT_APPLICABLE`), com nota e evidência, e registra achados com criticidade (`LOW` a `CRITICAL`) e recomendações, podendo vinculá-los a um risco do mapa.
- **Conclusão:** a manifestação é um documento `MANIFESTACAO_CONTROLE_INTERNO`, finalizado antes da conclusão com a situação `COMPLIANT`, `COMPLIANT_WITH_RECOMMENDATIONS` ou `NON_COMPLIANT`. A situação **não bloqueia** o processo por si; ela satisfaz a regra de saída `internalControl.concluded = true`, e a autoridade, ao autorizar com `NON_COMPLIANT` ou achado grave aberto, registra motivação (POL-23).
- **Acompanhamento:** cada achado segue `OPEN` → `ADDRESSED` (resposta de quem detém a custódia), `RISK_ACCEPTED` (autoridade, na decisão) ou `CANCELED` (Controle Interno, antes de concluir).

**Não há IA nesta feature** (DEC-200): texto, respostas, achados e situação são sempre humanos.

## Valor para o usuário e para o órgão
- O analista enxerga num lugar só o que o processo já registrou de risco e de aviso ignorado.
- Achados e recomendações deixam de ser parágrafos soltos e viram itens rastreáveis até o atendimento.
- A autoridade decide sabendo o que ficou em aberto, e a motivação fica registrada.

## Personas
- Controle interno (`CONTROLE_INTERNO`) — conduz e conclui a manifestação.
- Autoridade competente (`AUTORIDADE_COMPETENTE`) — lê e decide, com motivação quando houver ressalva grave.
- Planejamento (`PLANEJAMENTO`) e área requisitante (`REQUISITANTE`) — respondem aos achados quando têm a custódia.
- Auditor (`AUDITOR`) — rastreia.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-159 | Abrir a manifestação e painel do Controle Interno com visão de riscos | P0 | L | US-033, US-047, US-158 |
| US-160 | Responder o checklist e registrar achados e recomendações | P0 | M | US-159 |
| US-161 | Emitir a manifestação e concluir com a situação | P0 | M | US-065, US-110, US-129, US-160 |
| US-162 | Acompanhar o atendimento dos achados | P1 | S | US-160 |

## Escopo
- Abertura automática, fila do Controle Interno e atribuição do analista; início da análise (`PENDING` → `IN_REVIEW`).
- Painel SCR-020 com a visão de riscos e as respostas do checklist.
- Respostas com nota (obrigatória em `NON_COMPLIANT` e `NOT_APPLICABLE`) e evidência por versão de documento; papéis de trabalho como anexos.
- Achados e recomendações com criticidade, vínculo opcional a `Risk` e ao item do checklist.
- Manifestação como documento com template do órgão, rascunho restrito (POL-24) e versão final vinculada à conclusão, com as versões exatas analisadas.
- Conclusão com resumo (`conclusionSummary`), situação e a regra de saída da etapa.
- Rodadas: a devolução do processo mantém `IN_REVIEW` e reabre a rodada na volta.
- Acompanhamento dos achados e seus eventos na timeline.

## Fora de escopo
- IA para redigir a manifestação (não pedida no MVP 2).
- Bloqueio do processo por `NON_COMPLIANT` ou por achado aberto.
- Edição dos modelos de checklist (FT-076).
- Decisão da autoridade em si (etapa `AUTORIZACAO_LICITACAO`, EP-021/EP-022).
- Assinatura eletrônica da manifestação (MVP 3).

## Regras de negócio da feature
- RN-ICT-07 — A manifestação abre na entrada em `CONTROLE_INTERNO`, com o checklist publicado aplicável (regra de aplicabilidade, senão o padrão) fixado na abertura; há uma só aberta por processo (DEC-200).
- RN-ICT-08 — A visão de riscos reúne o mapa de riscos do processo e os avisos `WARNING` superados; a contagem é congelada na abertura em `warningsOverriddenCount` (DEC-200, L-08).
- RN-ICT-09 — `NOT_APPLICABLE` e `NON_COMPLIANT` exigem nota; todo item `NON_COMPLIANT` exige achado vinculado antes de concluir (DEC-200).
- RN-ICT-10 — Concluir exige todas as respostas obrigatórias diferentes de `PENDING`, a manifestação `FINALIZED` e `conclusionSummary` preenchido (DEC-200).
- RN-ICT-11 — `COMPLIANT_WITH_RECOMMENDATIONS` exige ao menos um achado com recomendação; `NON_COMPLIANT` exige ao menos um achado `HIGH` ou `CRITICAL` (DEC-200).
- RN-ICT-12 — `NON_COMPLIANT` e achados abertos **não bloqueiam** o processo por si: seguir adiante exige motivação da autoridade (≥ 50 caracteres) e o reconhecimento dos avisos na autorização (DEC-200, POL-23).
- RN-ICT-13 — A saída de `CONTROLE_INTERNO` exige `internalControl.concluded = true` (`BLOCKING`); `internalControl.openFindingsHighOrCritical > 0` gera `WARNING` na autorização (DEC-200).
- RN-ICT-14 — Quem manifesta não pode ter elaborado os documentos analisados nem aprovar o que analisou (segregação da POL-20) (DEC-200).
- RN-ICT-15 — Enquanto não finalizada, a manifestação só é lida por quem tem `INTERNAL_CONTROL_REVIEW_MANAGE` cobrindo o processo e pelo Auditor (POL-24) (DEC-200).
- RN-ICT-16 — A conclusão grava as versões exatas analisadas (`reviewedDocumentVersionIds`, inclusive o parecer) e a versão da manifestação (DEC-200).
- RN-ICT-17 — Achado `ADDRESSED` ou `RISK_ACCEPTED` exige resposta; `RISK_ACCEPTED` só é registrado pela autoridade com motivação na decisão de `AUTORIZACAO_LICITACAO`, e `CANCELED` só pelo Controle Interno antes da conclusão (DEC-200).
- RN-ICT-18 — Na devolução do processo a manifestação permanece `IN_REVIEW`; na volta abre-se nova rodada reaproveitando as respostas e achados abertos (DEC-200, DEC-196).
- RN-ICT-19 — Cancelamento do processo ou do ramo cancela a manifestação aberta, com motivo (DEC-200).
- RN-ICT-20 — Não há geração por IA na manifestação: `AI_GENERATE` não se aplica ao tipo `MANIFESTACAO_CONTROLE_INTERNO` (DEC-200, DEC-202).

## Telas
- SCR-020 — Controle Interno (fila e manifestação com visão de riscos) (`/controle-interno` e `/controle-interno/[reviewId]`).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `GET /internal-control/reviews` — fila do Controle Interno, filtrável por situação e responsável.
- `GET /internal-control/reviews/{id}` — painel: respostas, achados e visão de riscos.
- `POST /internal-control/reviews/{id}/start` — iniciar a análise (e atribuir).
- `PUT /internal-control/reviews/{id}/answers/{itemKey}` — responder item, com nota e evidência.
- `POST /internal-control/reviews/{id}/findings` — registrar achado e recomendação.
- `PATCH /internal-control/reviews/{id}/findings/{findingId}` — editar ou cancelar achado.
- `POST /internal-control/reviews/{id}/conclude` — concluir com a situação.
- `POST /internal-control/reviews/{id}/findings/{findingId}/respond` — registrar o atendimento.
- `GET /processes/{id}/internal-control` — manifestação vigente do processo (aba do processo).

## Entidades
- `InternalControlReview` — manifestação por processo e rodada (dono).
- `InternalControlChecklistAnswer` — resposta por item (dono).
- `InternalControlFinding` — achado e recomendação (dono).
- `Document` `MANIFESTACAO_CONTROLE_INTERNO` e `DocumentVersion` — texto e versões analisadas (consumida).
- `Risk` e `Attachment` (`INTERNAL_CONTROL_REVIEW`) — vínculos.

## Eventos
- `InternalControlReviewOpened` — entrada em `CONTROLE_INTERNO`.
- `InternalControlReviewStarted` — início da análise.
- `InternalControlFindingRecorded` — achado registrado (sem texto no payload).
- `InternalControlFindingResolved` — atendimento, risco aceito ou cancelamento.
- `InternalControlReviewConcluded` — conclusão (alimenta o read model, notificações e o `RuleContext`).
- `InternalControlReviewCanceled` — processo ou ramo cancelado.
- `DocumentFinalized` (`MANIFESTACAO_CONTROLE_INTERNO`) — manifestação emitida.

## Permissões
- `INTERNAL_CONTROL_REVIEW_VIEW` — fila e painel.
- `INTERNAL_CONTROL_REVIEW_MANAGE` — responder, achados, editar a manifestação (POL-20, POL-24).
- `INTERNAL_CONTROL_REVIEW_CONCLUDE` — concluir (POL-20).
- `PROCESS_VIEW` — ler a manifestação concluída; `APPROVAL_DECIDE` — autoridade (POL-23).

## Dependências
- FT-076 (checklist publicado), US-033 (registro de riscos, base da visão de riscos), US-047 (encaminhamento do processo, onde a ciência dos avisos `WARNING` é registrada — L-08), US-065 (ciclo de vida do documento), US-110 (biblioteca de templates) e US-129 (`RuleContext` v2, que expõe `internalControl.*` à regra de saída da etapa).
- EP-021 (`RuleContext` v2 e a etapa `CONTROLE_INTERNO`); EP-025 (parecer vigente, quando a ordem das etapas o coloca antes).

## Critérios de aceite da feature
```gherkin
Feature: Manifestação do Controle Interno
  Scenario: Manifestação com recomendações e processo que segue
    Given o processo "0012/2026" na etapa "CONTROLE_INTERNO" com o checklist "FASE_PREPARATORIA" v1 fixado
    When "Rita" (Controle Interno) iniciar a análise, responder todos os itens obrigatórios e registrar um achado "MEDIUM" com recomendação
    And finalizar a manifestação e concluir como "COMPLIANT_WITH_RECOMMENDATIONS"
    Then a manifestação deve ficar vinculada às versões analisadas e à versão final
    And a regra de saída da etapa deve ser satisfeita e o processo pode avançar
    And a timeline deve registrar a conclusão com a situação

  Scenario: Manifestação não conforme não bloqueia, mas exige motivação
    Given uma manifestação concluída como "NON_COMPLIANT" com um achado "HIGH" aberto
    When a autoridade tentar aprovar a autorização da licitação sem motivação
    Then o sistema deve recusar com "AUTHORIZATION_MOTIVATION_REQUIRED"
    When a autoridade aprovar com motivação de ao menos 50 caracteres e reconhecer os avisos
    Then o achado deve passar a "RISK_ACCEPTED" na mesma transação
```

## Métricas de sucesso
- Manifestações concluídas dentro do prazo da etapa ≥ 85%.
- 100% das conclusões com checklist respondido e versões analisadas gravadas.
- Achados `HIGH`/`CRITICAL` atendidos ou com risco aceito motivado ≥ 95%.

## Riscos
- Analista sobrecarregado pelo volume de itens — os itens `autoCheck` sugerem respostas e o checklist é configurável.
- Vazamento do rascunho ou de valores sigilosos na visão de riscos — POL-24 e POL-09, com testes de autorização e de tenant leak.
- Retorno do processo gerar rodadas confusas — rodada explícita e reaproveitamento das respostas.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
