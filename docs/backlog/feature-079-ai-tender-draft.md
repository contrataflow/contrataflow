---
id: FT-079
title: "IA no edital"
epic: EP-027
mvp: 2
priority: P1
stories: [US-169]
status: Especificada
---

# FT-079 — IA no edital

## Título
IA no edital

## Épico
EP-027 — Edital

## Descrição
Gerador `draft.tender` em cadeia a partir do TR (DEC-202). A pessoa de Licitações pede o rascunho do edital no assistente (SCR-117) sobre a minuta (SCR-021); a geração roda assíncrona na camada de IA do EP-020 e, ao terminar, o painel mostra a proposta por seção para aplicação seletiva. Seções preenchidas só são substituídas com confirmação, depois de uma versão automática.

As entradas são o TR, a pesquisa de preços, o mapa de riscos e o `Tender` (versões vigentes), com os mesmos `ContextSanitizer` (LGPD e sigilo do orçamento) e `GroundingGuard` do EP-020. A IA escreve **só texto** das seções do template: o cabeçalho tipado, os lotes, os valores e a matriz de riscos continuam com as pessoas, e a matriz proposta entra apenas como seção de texto, nunca como `TenderRiskAllocation`. O que não está nas entradas sai como **[a confirmar]**. O conteúdo aplicado fica "gerado por IA" até a revisão humana por seção (US-122).

## Valor para o usuário e para o órgão
- A primeira versão do edital sai em minutos, no formato do template do órgão.
- O que falta fica marcado, em vez de preenchido com suposição.
- Rastreabilidade completa do que a IA gerou e de quem revisou.

## Personas
- Licitações (`LICITACOES`) — solicita, aplica e revisa (`AI_GENERATE` ampliada — DEC-202).
- Administrador do órgão (`ADMIN_ORGAO`) — liga a IA, define limites e acompanha o consumo.
- Auditor (`AUDITOR`) e Controle Interno — rastreiam a proveniência.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-169 | Gerar o rascunho do edital com IA | P1 | L | US-115, US-116, US-122, US-164 |

## Escopo
- Gerador e prompt versionado `draft.tender` em `apps/api/src/modules/ai/prompts/draft.tender/`, com `AiGeneration.targetModule = TENDER`.
- Entradas em cadeia: `PROCESS`, `PROCESS_ITEMS`, `DOCUMENT_VERSION` (TR, pesquisa de preços, mapa de riscos), `TENDER`, `RISKS` e `TEMPLATE_VERSION` (entities.md §7.11).
- Fluxo genérico do EP-020: solicitar, acompanhar, aplicar seletivamente (DOC-26), descartar.
- Marcações "gerado por IA" e "[a confirmar]", revisão por seção obrigatória antes de concluir.
- Relatório de consumo com o gerador novo (AI-06, DEC-203).

## Fora de escopo
- Preencher cabeçalho tipado, lotes, valores, prazos ou a matriz de riscos.
- IA para a minuta do contrato, para o parecer (FT-075) ou para a manifestação do Controle Interno.
- Ajustes por seção além dos já entregues no EP-020 (reescrever, completar, resumir) quando aplicáveis ao `EDITAL`.
- Publicação ou qualquer ato sobre o edital.

## Regras de negócio da feature
- RN-TND-11 — O gerador exige o TR como antecessor e a minuta (`Tender`) criada; sem eles, 422 `AI_PREREQUISITE_MISSING` (DEC-202, cadeia do EP-020).
- RN-TND-12 — Gerar exige `AI_GENERATE` mais `TENDER_UPDATE` sobre o processo (POL-18 estendida a `TENDER`); aplicar só o solicitante (DEC-202).
- RN-TND-13 — A IA nunca decide: critério de julgamento, modalidade, lotes, valores e prazos ausentes das entradas saem como "[a confirmar]" (DEC-202, princípio 16).
- RN-TND-14 — Valor estimado só da pesquisa de preços concluída; com orçamento sigiloso, nunca vai à IA nem ao texto (DEC-202, DEC-030).
- RN-TND-15 — A matriz de riscos proposta é texto de seção e nunca grava `TenderRiskAllocation` (DEC-202).
- RN-TND-16 — Revisão humana por seção é obrigatória antes de finalizar o `EDITAL` (US-122, DEC-202).
- RN-TND-17 — Opt-in e limites por órgão (`ai.enabled`, `ai.monthlyTokenLimit`, `ai.userDailyRequestLimit`); IA incluída no plano, sem cobrança por uso (DEC-203).
- RN-TND-18 — A proposta guarda as versões usadas (`inputRefs`); se o TR mudar depois, aparece aviso para gerar de novo (DEC-202, padrão do EP-020).

## Telas
- SCR-117 — Assistente de redação com IA (painel lateral).
- SCR-021 — Edital (badges "Gerado por IA", menu de IA por seção, chips [a confirmar]).

## Endpoints
_Indicativos — IDs e contratos no `api.md` do MVP 2._
- `POST /processes/{id}/ai-generations` (AI-01 do MVP 1) com `targetModule = TENDER` — solicitar o rascunho do edital; não há rota própria.
- `GET /ai/generations/{id}` — acompanhar a geração (AI-02 do MVP 1).
- `POST /documents/{id}/ai-apply` — aplicar seções da proposta (DOC-26 do MVP 1).
- `POST /ai/generations/{id}/discard` — descartar a proposta (AI-04 do MVP 1).

## Entidades
- `AiGeneration` — registro da geração, `output` e `inputRefs` (dono `ai`; §5.12).
- `Document` `EDITAL` — `draftContent` com proveniência por seção.
- `DocumentVersion` — versão automática antes de substituir seção preenchida.
- `Tender` — entrada (cabeçalho).

## Eventos
- `AiGenerationRequested`, `AiGenerationCompleted`, `AiGenerationFailed` — ciclo da geração.
- `AiContentApplied` — aplicação (e `DocumentVersionCreated` quando substitui seção preenchida).
- `AiContentReviewed` — revisão por seção.

## Permissões
- `AI_GENERATE` — solicitar (ampliada a `LICITACOES` e `JURIDICO` — DEC-202).
- `TENDER_UPDATE` — aplicar e revisar (POL-02, POL-18).
- `SETTINGS_MANAGE` — configuração e consumo (EP-020).

## Dependências
- FT-078 (a minuta existe e o TR foi importado — US-164).
- US-115 (camada de IA), US-116 (configuração e limites), US-122 (marcações e revisão obrigatória) do EP-020.
- ADR-013 / PEND-21 (provedor): `FakeAiProvider` até a decisão.

## Critérios de aceite da feature
```gherkin
Feature: Rascunho do edital com IA
  Scenario: Gerar, aplicar e revisar o edital sem números inventados
    Given que a IA está ligada no órgão e "Lia" tem "AI_GENERATE" e "TENDER_UPDATE" no processo "0012/2026"
    And a minuta do edital existe com o TR importado
    When "Lia" gerar o rascunho do edital e aplicar as seções
    Then cada seção aplicada deve ficar marcada "Gerado por IA — revisão pendente"
    And nenhum valor, prazo ou quantidade ausente das entradas deve aparecer no texto, apenas como "[a confirmar]"
    And a matriz de riscos proposta deve aparecer como texto e não como linhas da matriz
    And o edital não pode ser finalizado antes da revisão humana das seções geradas

  Scenario: Orçamento sigiloso
    Given um processo com orçamento sigiloso
    When "Lia" gerar o rascunho do edital
    Then nenhum valor estimado deve ser enviado ao provedor nem aparecer na proposta
```

## Métricas de sucesso
- Rascunho p95 ≤ 90 s.
- ≥ 60% das propostas concluídas são aplicadas.
- 0 números inventados na minuta final (revisão humana e `GroundingGuard`).

## Riscos
- Conteúdo plausível porém errado — só fatos das entradas, `GroundingGuard`, "[a confirmar]" e revisão obrigatória.
- Custo fora de controle — limites mensal e diário e alertas de consumo (DEC-203).
- Dependência do provedor — porta `AiProvider` e `FakeAiProvider`; PEND-21 segue aberta.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (com o `FakeAiProvider`)
- [ ] Documentação atualizada
