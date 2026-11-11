---
id: FT-075
title: "IA no parecer jurídico"
epic: EP-025
mvp: 2
priority: P1
stories: [US-157]
status: Especificada
---

# FT-075 — IA no parecer jurídico

## Título
IA no parecer jurídico

## Épico
EP-025 — Jurídico

## Descrição
O procurador pede à IA um rascunho do parecer jurídico, no editor do `PARECER_JURIDICO`, usando a mesma camada do EP-020. O gerador `draft.legal_opinion` trabalha **em cadeia**: lê as versões vigentes de DFD, ETP, mapa de riscos, pesquisa de preços, TR, a dotação (classificação e cobertura), a minuta do edital e, na retomada, as diligências anteriores, e propõe as seções do template do órgão: relatório, fundamentação, análise dos artefatos e ressalvas sugeridas.

A IA **nunca propõe a conclusão** do parecer: a seção de conclusão sai sempre como [a confirmar] (categoria `DECISION`) e a situação (`FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`) é escolhida pelo procurador. O resultado é uma proposta por seção, aplicada seletivamente, marcada "gerado por IA" e sujeita à revisão humana obrigatória antes de finalizar.

## Valor para o usuário e para o órgão
- Reduz o trabalho de redigir o relatório e a análise dos artefatos, mantendo a decisão com o procurador.
- Cada afirmação do rascunho vem das entradas rastreadas; o que falta aparece como [a confirmar].
- O órgão usa IA no ato mais sensível da fase preparatória com limites, opt-in e rastreabilidade.

## Personas
- Jurídico / procurador (`JURIDICO`) — pede, aplica, revisa e assina o parecer.
- Administrador do órgão (`ADMIN_ORGAO`) — liga a IA, define limites e acompanha o consumo.
- Auditor (`AUDITOR`) — rastreia o que foi gerado por IA, por quem e com quais entradas.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-157 | Gerar o rascunho do parecer jurídico com IA | P1 | L | US-115, US-116, US-122, US-154 |

## Escopo
- Gerador e prompt `draft.legal_opinion`, versionado em `apps/api/src/modules/ai/prompts/legal_opinion/`.
- `AiGeneration` com `targetModule = LEGAL_OPINION`; entradas `PROCESS`, `PROCESS_ITEMS`, `DOCUMENT_VERSION`, `BUDGET_ALLOCATIONS`, `TENDER`, `LEGAL_REVIEW`, `TEMPLATE_VERSION`.
- Saída só de `sections` (sem riscos tipados); seção `CONCLUSION` sempre `toConfirm` com categoria `DECISION`.
- Painel do assistente (SCR-117) no editor do parecer: solicitar, acompanhar, aplicar por seção e descartar.
- Aplicação seletiva por seção, com versão automática antes de substituir seção preenchida; aplicar a conclusão não altera `LegalReview.status`.
- Marcações "gerado por IA" e [a confirmar] e revisão humana por seção antes de finalizar o parecer.
- Limites por órgão e consumo (DEC-203), `ContextSanitizer` e `GroundingGuard`.

## Fora de escopo
- Qualquer sugestão de conclusão, situação ou ressalva como decisão; a IA pode listar pontos de atenção apenas como texto de seção.
- Gerar a minuta do edital (`draft.tender`, EP-027) ou a manifestação do Controle Interno (sem IA no MVP 2).
- Ajuste por seção (reescrever, completar, resumir) além do que a US-121 do EP-020 já oferece aos editores.
- Escolha de provedor de IA (PEND-21, ADR-013).

## Regras de negócio da feature
- RN-LGL-21 — A IA do parecer nunca propõe a conclusão: a seção de conclusão sai como [a confirmar] (`DECISION`) e `output` nunca carrega situação conclusiva; o `GroundingGuard` rejeita a saída com `OUTPUT_INVALID` se vier (DEC-202).
- RN-LGL-22 — A situação do parecer é escolhida só por pessoa com `LEGAL_REVIEW_CONCLUDE`; aplicar a seção de conclusão não altera `LegalReview.status` (DEC-202, POL-18 estendida).
- RN-LGL-23 — Gerar exige `AI_GENERATE` mais `LEGAL_REVIEW_MANAGE` cobrindo o processo (POL-18 estendida, POL-19, POL-24); a IA precisa estar ligada no órgão (`ai.enabled`) (DEC-202).
- RN-LGL-24 — As entradas são as versões vigentes dos documentos da cadeia; a proposta guarda as versões usadas (`inputRefs`) e avisa se algum insumo era rascunho (DEC-202).
- RN-LGL-25 — Nada é inventado: números, valores, prazos e fundamentos ausentes das entradas aparecem como [a confirmar]; valores de orçamento sigiloso nunca vão ao prompt (DEC-030, DEC-202, RN-AI-05).
- RN-LGL-26 — O texto aplicado fica "gerado por IA" até a revisão humana por seção; o parecer só é finalizado, e a análise só é concluída, com todas as seções revisadas (US-122, DEC-202).
- RN-LGL-27 — Valem os limites `ai.monthlyTokenLimit` e `ai.userDailyRequestLimit` e o custo incluído no plano, sem cobrança por uso; o consumo do gerador novo aparece no relatório por órgão (DEC-203).

## Telas
- SCR-117 — Assistente de redação com IA (painel lateral sobre o editor do parecer).
- SCR-019 — Jurídico: painel de análise, com indicação de seções pendentes de revisão.
- SCR-041 — Configurações gerais, seção "Inteligência artificial" (limites e consumo).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /processes/{id}/ai-generations` (AI-01) — estendido para `kind = DRAFT` com `promptKey = draft.legal_opinion`.
- `GET /ai-generations/{id}` (AI-02) e descarte (AI-04) — acompanhar e descartar a proposta.
- `POST /documents/{id}/ai-apply` (DOC-26) — aplicar seções ao `PARECER_JURIDICO`.
- `POST /documents/{id}/ai-review` (DOC-27) — registrar a revisão humana por seção.

## Entidades
- `AiGeneration` — registro, entradas e proposta (`targetModule = LEGAL_OPINION`).
- `Document.draftContent` — seções e proveniência.
- `LegalReview` — rodada e diligências como entrada (leitura).
- `BudgetAllocation` e `Tender` — entradas (classificação e cobertura, sem valores sigilosos).

## Eventos
- `AiGenerationRequested`, `AiGenerationCompleted`, `AiGenerationFailed` — ciclo da geração.
- `AiContentApplied` — aplicação; `DocumentVersionCreated` ao substituir seção preenchida.
- `AiContentReviewed` — revisão por seção.
- `AiUsageThresholdReached` — alerta de consumo do órgão.

## Permissões
- `AI_GENERATE` e `LEGAL_REVIEW_MANAGE` — solicitar, aplicar e revisar (POL-18 estendida, POL-19, POL-24).
- `LEGAL_REVIEW_CONCLUDE` — escolher a situação conclusiva (nunca pela IA).
- `SETTINGS_MANAGE` — limites e consumo.

## Dependências
- FT-074 (editor e ciclo do parecer, US-154) e a camada de IA do EP-020 (US-115, US-116, US-122).
- Dotação (EP-024) e minuta do edital (EP-027) como entradas; ADR-013 (PEND-21) para o provedor real; `FakeAiProvider` até lá.

## Critérios de aceite da feature
```gherkin
Feature: IA no parecer jurídico
  Scenario: Rascunho assistido sem conclusão sugerida
    Given que a IA está ligada no órgão e "Dr. André" tem "AI_GENERATE" e "LEGAL_REVIEW_MANAGE" na análise "0045/2026"
    When "Dr. André" gerar o rascunho do parecer e aplicar todas as seções
    Then o parecer deve ter as seções do template preenchidas e marcadas "Gerado por IA — revisão pendente"
    And a seção de conclusão deve conter apenas "[a confirmar]" e a situação da análise deve permanecer "IN_REVIEW"
    And nenhum valor, prazo ou fundamento ausente das entradas deve aparecer no texto
    When "Dr. André" tentar finalizar o parecer antes de revisar as seções geradas
    Then o sistema deve impedir a finalização
    When "Dr. André" revisar todas as seções, finalizar o parecer e escolher a situação conclusiva
    Then a análise deve ser concluída com a situação escolhida por ele
```

## Métricas de sucesso
- Redução ≥ 30% no tempo de elaboração do parecer frente aos pareceres sem IA.
- ≥ 60% das propostas concluídas são aplicadas.
- 0 situações conclusivas propostas pela IA (amostragem e conjunto de avaliação).
- Rascunho completo p95 ≤ 90 s.

## Riscos
- Conteúdo plausível porém errado — só fatos das entradas, `GroundingGuard`, [a confirmar] e revisão humana obrigatória.
- Insumo desatualizado depois da geração — `inputRefs` e aviso para gerar de novo na retomada da análise.
- Dados pessoais e sigilosos no prompt — `ContextSanitizer`, minimização e opt-in com termos revisados pelo jurídico/DPO.
- Dependência do provedor — porta `AiProvider` e `FakeAiProvider` (PEND-21).

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (com o `FakeAiProvider`, incluindo a conclusão sempre [a confirmar])
- [ ] Documentação atualizada
