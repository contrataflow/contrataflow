---
id: FT-061
title: "Rascunhos com IA"
epic: EP-020
mvp: 1
priority: P1
stories: [US-117, US-118, US-119, US-120]
status: Especificada
---

# FT-061 — Rascunhos com IA

## Título
Rascunhos com IA

## Épico
EP-020 — IA para documentos do planejamento

## Descrição
Rascunho completo dos quatro documentos do planejamento, gerado pela IA no editor, **em cadeia**:
- **DFD:** a partir do resumo da necessidade escrito pela pessoa e dos dados do processo (US-117);
- **ETP:** a partir do DFD, dos itens, das alternativas e da pesquisa de preços (US-118);
- **Mapa de riscos:** riscos e tratamentos estruturados, mais as seções narrativas (US-119);
- **TR:** a partir do ETP, dos riscos, da pesquisa de preços e das condições tipadas do TR (US-120).

Os rascunhos usam as seções, orientações e base legal dos templates do órgão.

A geração é assíncrona e a pessoa continua trabalhando enquanto ela roda. Ao terminar, o painel do assistente (SCR-117) mostra a proposta por seção, e a pessoa escolhe o que aplicar:
- seções vazias vêm marcadas;
- seções preenchidas só são substituídas com confirmação, e antes disso o sistema cria uma versão automática.

O conteúdo aplicado fica "gerado por IA" até ser revisado (FT-062). A IA escreve **só texto**: campos tipados, itens, quantidades, alternativas, decisões e valores continuam com as pessoas e com a pesquisa de preços.

## Valor para o usuário e para o órgão
- O DFD sai de poucas linhas para um rascunho completo em até 90 s.
- ETP e TR nascem coerentes com o DFD e entre si, reduzindo devoluções por inconsistência.
- O que falta aparece marcado como **[a confirmar]**, em vez de preenchido com suposições.

## Personas
- Área requisitante (`REQUISITANTE`) — DFD.
- Planejamento (`PLANEJAMENTO`) — ETP, mapa de riscos e TR.
- Compras (`COMPRAS`) e gestor de contratações (`GESTOR_CONTRATACOES`) — TR e acompanhamento.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-117 | Gerar o rascunho do DFD com IA a partir do resumo da necessidade | P1 | L | US-015, US-116, US-122 |
| US-118 | Gerar o rascunho do ETP com IA a partir do DFD | P1 | M | US-020, US-022, US-117 |
| US-119 | Gerar a proposta do mapa de riscos com IA | P1 | M | US-034, US-035, US-117 |
| US-120 | Gerar o rascunho do TR com IA a partir do ETP | P1 | M | US-036, US-038, US-117 |

## Escopo
- Fluxo genérico, entregue na US-117 e reutilizado pelas demais:
  - solicitar (AI-01, `kind = DRAFT`);
  - acompanhar (AI-02 e notificações);
  - aplicar seletivamente (DOC-26);
  - descartar (AI-04).
- Painel SCR-117 nos editores.
- Geradores e prompts `draft.dfd`, `draft.etp`, `draft.risk_map` e `draft.tr`, com as entradas de cada documento e a precedência de versão dos antecessores: aprovada > finalizada > rascunho, com aviso no último caso.
- Riscos estruturados: proposta, aplicação seletiva (RSK-11) e revisão (RSK-12).

## Fora de escopo
- Ajuste por seção e revisão das seções (FT-062).
- Criação dos documentos (DFD-02, ETP-02, TRM-02 e RSK-10 continuam manuais).
- Preenchimento de campos tipados, itens, alternativas ou valores.
- Parecer e edital (MVP 2).

## Regras de negócio da feature
- RN-AI-25..RN-AI-32 (DFD e fluxo genérico), RN-AI-33..RN-AI-37 (ETP), RN-AI-38..RN-AI-42 (mapa de riscos), RN-AI-43..RN-AI-46 (TR).
- Cadeia: ETP exige DFD; mapa de riscos exige DFD; TR exige ETP. Sem o antecessor, 422 `AI_PREREQUISITE_MISSING`.
- Valor estimado só da pesquisa de preços concluída; com orçamento sigiloso, nunca.
- A IA não decide: conclusão de viabilidade, solução escolhida e parcelamento vêm como [a confirmar] enquanto a equipe não decidir.

## Telas
- SCR-117 — Assistente de redação com IA (painel lateral).
- SCR-007 — DFD, SCR-008 — ETP, SCR-011 — Riscos, SCR-012 — TR.

## Endpoints
- AI-01 / AI-02 / AI-04 — solicitar, acompanhar e descartar.
- DOC-26 `POST /documents/{id}/ai-apply` — aplicar seções.
- RSK-11 `POST /processes/{id}/risks/ai-apply` — aplicar riscos e tratamentos.
- RSK-12 `POST /processes/{id}/risks/ai-review` — revisar riscos gerados.

## Entidades
- `AiGeneration` (proposta em `output`).
- `Document.draftContent` (seções e proveniência).
- `Risk`/`RiskTreatment` (`aiGenerationId`, `aiReviewedAt`).
- `DocumentVersion` (versão automática antes de substituir seção preenchida).

## Eventos
- `AiGenerationRequested`, `AiGenerationCompleted`, `AiGenerationFailed` — ciclo da geração.
- `AiContentApplied` — aplicação (+ `RiskCreated` por risco; `DocumentVersionCreated` quando substitui seção preenchida).
- `AiContentReviewed` — revisão dos riscos.

## Permissões
- `AI_GENERATE` + POL-18 — solicitar.
- `DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE`, `TERM_UPDATE` + POL-02 — aplicar e revisar (aplicar só o solicitante).

## Dependências
- FT-060 (camada e governança) e US-122 (marcações e revisão).
- Editores: US-015 (DFD), US-020/US-022 (ETP), US-034/US-035 (riscos), US-036/US-038 (TR).

## Critérios de aceite da feature
```gherkin
Feature: Rascunhos em cadeia com IA
  Scenario: Do resumo da necessidade ao TR, sem números inventados
    Given que a IA está ligada no órgão e "Ana" tem "AI_GENERATE" e custódia do processo "0012/2026"
    When "Ana" gerar o rascunho do DFD a partir de um resumo de três linhas e aplicar todas as seções
    And o DFD for aprovado
    And "Carla" gerar e aplicar os rascunhos do ETP, do mapa de riscos e do TR
    Then cada documento deve ter as seções do template do órgão preenchidas e marcadas "Gerado por IA — revisão pendente"
    And nenhum valor, quantidade ou prazo ausente das entradas deve aparecer no texto, apenas como "[a confirmar]"
    And o valor estimado do TR deve ser o da pesquisa de preços concluída
    And nenhum dos documentos pode ser finalizado antes da revisão humana das seções geradas
```

## Métricas de sucesso
- Rascunho completo p95 ≤ 90 s.
- ≥ 60% das propostas concluídas são aplicadas.
- Redução ≥ 30% no tempo de elaboração (criação → finalização) dos documentos com IA.

## Riscos
- O rascunho do antecessor muda depois da geração — a proposta guarda as versões usadas (`inputRefs`), e o aviso `USED_DRAFT_INPUTS` orienta gerar de novo após a aprovação.
- A proposta pode ser grande demais para a revisão — a aplicação seletiva por seção e a revisão por seção permitem trabalhar em partes.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada (DFD → ETP → mapa de riscos → TR com o `FakeAiProvider`)
- [ ] Documentação atualizada
