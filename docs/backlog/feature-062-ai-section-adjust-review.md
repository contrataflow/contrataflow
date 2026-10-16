---
id: FT-062
title: "Ajuste por seção e revisão"
epic: EP-020
mvp: 1
priority: P1
stories: [US-121, US-122]
status: Especificada
---

# FT-062 — Ajuste por seção e revisão

## Título
Ajuste por seção e revisão

## Épico
EP-020 — IA para documentos do planejamento

## Descrição
Em qualquer seção narrativa dos quatro documentos, a pessoa pode pedir à IA para **reescrever**, **completar** ou **resumir**, com uma orientação opcional. Ela compara o texto atual com o sugerido e aplica, com a opção de desfazer enquanto o painel estiver aberto (US-121).

A US-122 garante que o conteúdo de IA nunca avance sem revisão humana:
- a marcação **[a confirmar]** é um nó do editor, inserido pela IA ou pela pessoa;
- o *GroundingGuard* troca por [a confirmar] todo número, valor, prazo, data ou percentual que não esteja nas entradas;
- a proveniência "gerado por IA" vale por seção;
- a revisão é explícita, por seção ou em lote;
- violações **bloqueantes** de completude impedem finalizar, submeter ou encaminhar o documento enquanto houver conteúdo de IA não revisado ou marcações pendentes;
- a prévia em PDF mostra essas pendências.

## Valor para o usuário e para o órgão
- O texto é melhorado sem sair do editor e sem perder o controle: a pessoa vê o antes e o depois.
- Fica garantido, e demonstrável a órgãos de controle, que todo conteúdo de IA foi revisado por uma pessoa identificada antes de virar versão final (princípio 16).

## Personas
- Redatores (`REQUISITANTE`, `PLANEJAMENTO`, `COMPRAS`) — ajustam e revisam seções.
- Participantes `COLLABORATOR`/`CONSULTANT` — revisam conteúdo aplicado (não geram).
- Aprovadores e auditores — confiam que a versão final não tem pendências de IA.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-121 | Ajustar seção com IA: reescrever, completar e resumir | P1 | M | US-020, US-035, US-036, US-117 |
| US-122 | Marcar conteúdo gerado por IA e pendências "[a confirmar]" e exigir revisão humana | P1 | M | US-065, US-067, US-115 |

## Escopo
- AI-01 com `kind = SECTION` e as ações `REWRITE`, `COMPLETE` e `SUMMARIZE`; prompts `section.*`.
- `baseRevision` e `AI_SUGGESTION_STALE`; aplicação por DOC-26 após comparação lado a lado.
- Nó `toConfirm` em `packages/editor` e no validador do backend.
- *GroundingGuard*; proveniência `DraftContent.sections[].ai`; DOC-27 (revisão).
- Violações `SECTION_AI_REVIEW_PENDING` e `SECTION_PLACEHOLDER_PENDING`; nota na prévia em PDF.

## Fora de escopo
- Ajuste de campos tipados, itens ou riscos individuais.
- Revisão automática.
- Impressão da proveniência no PDF final (fica nos metadados da versão e na auditoria).

## Regras de negócio da feature
- RN-AI-47..RN-AI-52 (ajuste) e RN-AI-53..RN-AI-58 (marcações e revisão).
- Conteúdo ajustado volta a "revisão pendente".
- Editar o texto não equivale a revisar.
- Revisão em lote exige confirmação explícita.

## Telas
- SCR-117 — Assistente de redação com IA (comparação e "Desfazer").
- SCR-007, SCR-008, SCR-011 e SCR-012 — `AiSectionMenu`, `AiGeneratedBadge`, `MarkReviewedButton`, `ReviewAllDialog`, `ToConfirmChip`.

## Endpoints
- AI-01 `POST /processes/{id}/ai-generations` (`kind = SECTION`) — pedir o ajuste.
- DOC-26 `POST /documents/{id}/ai-apply` — aplicar o ajuste.
- DOC-27 `POST /documents/{id}/ai-review` — marcar seções como revisadas.
- DOC-08 `GET /documents/{id}/validation` — novas violações bloqueantes.
- DOC-20 `POST /documents/{id}/preview` — prévia com as marcações.

## Entidades
- `AiGeneration` (`kind = SECTION`, `action`, `sectionKey`, `baseRevision`).
- `Document.draftContent` (nó `toConfirm`, proveniência `ai`).

## Eventos
- `AiContentApplied` — ajuste aplicado.
- `AiContentReviewed` — seções revisadas (→ timeline `AI_CONTENT_REVIEWED`).

## Permissões
- `AI_GENERATE` + POL-18 — pedir ajuste.
- Permissão de edição do tipo + POL-02 — aplicar (só o solicitante) e revisar.

## Dependências
- US-115 (pipeline e pós-processamento), US-117 (painel e aplicação), US-065 (validação de completude), US-067 (prévia em PDF), editores (US-020, US-035, US-036).

## Critérios de aceite da feature
```gherkin
Feature: Ajuste e revisão do conteúdo gerado por IA
  Scenario: Reescrever uma seção e concluir só depois da revisão
    Given que o ETP do processo "0012/2026" tem a seção "REQUIREMENTS" aplicada pela IA e ainda não revisada
    When "Carla" pedir à IA para reescrever a seção com a orientação "mais objetivo" e aplicar a sugestão
    Then a seção deve continuar marcada "Gerado por IA — revisão pendente"
    When "Carla" tentar concluir o ETP
    Then a API deve responder 422 com código "DOCUMENT_INCOMPLETE" e a violação "SECTION_AI_REVIEW_PENDING" em "REQUIREMENTS"
    When "Carla" resolver as marcações "[a confirmar]" e marcar a seção como revisada
    Then a conclusão deve ser aceita e a timeline deve mostrar "AI_CONTENT_REVIEWED"
```

## Métricas de sucesso
- Ajuste de seção p95 ≤ 20 s.
- 100% das versões finais sem `toConfirm` nem proveniência não revisada (verificado em teste e auditoria).

## Riscos
- Revisão "de fachada" (marcar sem ler) — confirmação explícita no lote, nome de quem revisou na auditoria e na timeline, treinamento.
- Falso positivo do *GroundingGuard* (troca de número legítimo) — conjunto de fatos inclui os dados do processo e os anos; exceções para citações legais; contador `groundingReplacements` monitorado.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (ajustar → revisar → concluir)
- [ ] Documentação atualizada
