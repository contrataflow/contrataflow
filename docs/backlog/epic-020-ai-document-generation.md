---
id: EP-020
title: "IA para documentos do planejamento"
mvp: 1
priority: P1
features: [FT-060, FT-061, FT-062]
status: Especificado
---

# EP-020 — IA para documentos do planejamento

## Título
IA para documentos do planejamento

## Objetivo
Reduzir o tempo e a dificuldade de elaborar DFD, ETP, mapa de riscos e TR. A pessoa descreve a necessidade em poucas linhas e a IA preenche o documento no editor com os dados do processo, os templates do órgão e a base legal da Lei 14.133/2021. Depois a pessoa ajusta cada seção (reescrever, completar, resumir), revisa e segue o fluxo normal de aprovação. A IA nunca decide nem inventa dados.

## Contexto e problema
- Os quatro documentos do planejamento (art. 18 da Lei 14.133/2021) são o trabalho mais demorado da fase preparatória. Os servidores dos órgãos pequenos têm pouco tempo e pouca prática nisso. O principal concorrente vende a geração desses documentos com IA como carro-chefe (prd-3).
- O plano anterior só trazia IA no MVP 5, e apenas para assistir e validar. O usuário decidiu em 2026-10-14 antecipar a **geração** para o MVP 1, antes do lançamento e logo depois dos editores (DEC-037).
- Os editores, o modelo documental (DEC-017), as versões imutáveis, os templates por órgão (EP-018), a auditoria (EP-013) e a timeline (EP-010) já existem. Este épico acrescenta:
  - a camada `AiProvider` e o módulo `ai` (DEC-079), só com fachadas de leitura (regra D9);
  - a geração assíncrona com rastreabilidade;
  - a aplicação e a revisão humanas.
- Base legal e princípios: art. 18, §§ 1º e 2º, da Lei 14.133/2021; princípio 16 do produto (a IA nunca decide); LGPD (DEC-140); sigilo do orçamento (DEC-030).

## Escopo
- Módulo `ai` e porta `AiProvider` com o `FakeAiProvider` (o provedor real depende da ADR-013 / PEND-21).
- Registro `AiGeneration`: quem, documento/seção, modelo, versão do prompt, entradas, tokens, custo e latência.
- Fila `ai-generation`; auditoria, eventos, timeline e notificações (US-115).
- Configuração por órgão (US-116):
  - ativação opt-in com aceite de termos;
  - limite mensal de tokens e limite diário por usuário;
  - permissão `AI_GENERATE` e POL-18;
  - relatório de consumo.
- Rascunho completo, em cadeia, de DFD (US-117), ETP (US-118), mapa de riscos (US-119: riscos e tratamentos estruturados + seções) e TR (US-120), com aplicação seletiva por seção.
- Ajuste por seção: reescrever, completar e resumir (US-121).
- Marcações "gerado por IA" e **[a confirmar]**, *GroundingGuard* contra números inventados e revisão humana obrigatória antes de finalizar (US-122).

## Fora de escopo
- Parecer jurídico e edital (MVP 2, quando esses documentos existirem).
- Validações cruzadas entre documentos, saúde do processo, recomendações, benchmark de preços, busca semântica, embeddings e assistente conversacional (MVP 5).
- Qualquer IA que aprove, encaminhe, publique, decida, crie alternativa de solução ou defina valor.
- Escolha de provedor por órgão; uso de anexos e comentários como entrada; geração da pesquisa de preços.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Área requisitante | `REQUISITANTE` | Formalizar a demanda (DFD) a partir de poucas linhas, sem saber redigir no formato legal |
| Planejamento | `PLANEJAMENTO` | Produzir ETP, mapa de riscos e TR coerentes com o DFD em menos tempo |
| Compras | `COMPRAS` | Ajustar o TR e reaproveitar o valor da pesquisa de preços sem retrabalho |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Ganhar escala nos processos da carteira, mantendo a revisão humana |
| Administrador do órgão | `ADMIN_ORGAO` | Ligar ou desligar a IA, definir limites, acompanhar o consumo e decidir quem pode gerar |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Rastrear o que foi gerado por IA, por quem, com quais dados e quem revisou |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-060 | Camada de IA e governança | US-115, US-116 | P1 |
| FT-061 | Rascunhos com IA | US-117, US-118, US-119, US-120 | P1 |
| FT-062 | Ajuste por seção e revisão | US-121, US-122 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-115 | Camada de IA com registro e rastreabilidade das gerações | P1 | L | 8 |
| US-116 | Configurar a IA no órgão: ativação, limites e consumo | P1 | M | 5 |
| US-117 | Gerar o rascunho do DFD com IA a partir do resumo da necessidade | P1 | L | 8 |
| US-118 | Gerar o rascunho do ETP com IA a partir do DFD | P1 | M | 5 |
| US-119 | Gerar a proposta do mapa de riscos com IA | P1 | M | 5 |
| US-120 | Gerar o rascunho do TR com IA a partir do ETP | P1 | M | 5 |
| US-121 | Ajustar seção com IA: reescrever, completar e resumir | P1 | M | 5 |
| US-122 | Marcar conteúdo gerado por IA e pendências "[a confirmar]" e exigir revisão humana | P1 | M | 5 |
| **Total** | | | | **46** |

## Módulos e entidades
- Módulos:
  - `ai` (novo, nível 5);
  - `document`, que aplica seções e faz a revisão (DOC-26/27, completude);
  - `risk`, que aplica e revisa riscos (RSK-11/12);
  - leitura de `process`, `dfd`, `etp`, `term`, `price-research`, `tenancy` e `catalog`;
  - transversais `timeline`, `notification`, `audit` e `platform` (fila e outbox).
- Entidades: `AiGeneration` (dono `ai`); `DraftContent.sections[].ai` (proveniência — `document`); `Risk.aiGenerationId`/`aiReviewedAt` e `RiskTreatment.aiGenerationId` (`risk`); `TenantSetting` `ai.*` (`tenancy`).

## Telas
- SCR-117 — Assistente de redação com IA (painel lateral sobre SCR-007, SCR-008, SCR-011 e SCR-012).
- SCR-041 — Configurações gerais, seção "Inteligência artificial".
- SCR-007, SCR-008, SCR-011 e SCR-012 — badges "Gerado por IA", menu de IA por seção, chips [a confirmar].

## Integrações
- Provedor de IA externo atrás da porta `AiProvider` (ADR-013 — pendente: Anthropic via Amazon Bedrock recomendado; alternativas OpenAI e Azure OpenAI).
- Internas: fila `ai-generation` (BullMQ), outbox e relay, `NotificationDispatcher`, `TimelineProjector`, renderização de prévia (Gotenberg).

## Eventos principais
- `AiGenerationRequested`, `AiGenerationCompleted`, `AiGenerationFailed`, `AiContentApplied`, `AiContentReviewed`, `AiUsageThresholdReached`.

## Permissões envolvidas
- `AI_GENERATE` (nova, POL-18); `DFD_UPDATE`, `ETP_UPDATE`, `RISK_MANAGE` e `TERM_UPDATE` (aplicar e revisar); `PROCESS_VIEW` (consultar gerações); `SETTINGS_MANAGE` (configuração e consumo).

## Regras configuráveis
- `ai.enabled` — liga a IA no órgão (padrão desligado; exige aceite dos termos).
- `ai.termsAcceptedVersion` — versão dos termos aceita.
- `ai.monthlyTokenLimit` — limite mensal do órgão (padrão 2.000.000 tokens; PEND-22).
- `ai.userDailyRequestLimit` — gerações por usuário por dia (padrão 40).
- Matriz de perfis — quem tem `AI_GENERATE`.
- Templates do órgão — seções, orientações, base legal e `aiHints` usados pelos prompts.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Documentos do planejamento iniciados com rascunho de IA | ≥ 50% nos órgãos com IA ligada (3 meses) | `AiGeneration` `APPLIED` × documentos criados |
| Tempo médio de elaboração (criação → finalização) de DFD/ETP/TR | Redução ≥ 30% em relação aos processos sem IA | `Document.createdAt` × `finalizedAt` |
| Propostas aplicadas (aplicadas ÷ concluídas com sucesso) | ≥ 60% | `cf_ai_generations_total{status}` |
| Devoluções por inconsistência em documentos gerados por IA | Não superior às dos documentos sem IA | Movimentos `RETURN` × proveniência |
| Números inventados que chegam ao documento final | 0 (revisão + *GroundingGuard*) | Amostragem do conjunto de avaliação e auditoria |
| Rascunho completo p95 | ≤ 90 s | `cf_ai_generation_duration_seconds` |

## Dependências
- **Depende de:**
  - EP-002, EP-003, EP-005 e EP-006 — os editores dos quatro documentos;
  - EP-011 — documentos, versões e PDF;
  - EP-015 — worker e outbox;
  - EP-016 e EP-017 — permissões e configurações;
  - EP-010, EP-013 e EP-019 — timeline, auditoria e notificações.
- **Habilita:** MVP 2 (geração de parecer jurídico e edital); MVP 5 (assistente, validações e busca semântica sobre o mesmo módulo `ai`).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Conteúdo plausível mas errado (alucinação) | Alta | Alto | Só fatos das entradas; *GroundingGuard*; [a confirmar]; revisão humana obrigatória; conjunto de avaliação |
| Transferência internacional e LGPD | Média | Alto | Minimização, sem valores sigilosos, cláusulas-padrão da ANPD, opt-in com termos, decisão do usuário na ADR-013 |
| Custo fora de controle | Média | Médio | Limites mensal e diário, reserva de tokens, alertas de 80% e 100%, relatório de consumo |
| Injeção de instruções no texto dos documentos | Média | Médio | Delimitação dos dados no prompt, saída só estruturada, sem ferramentas, sanitização do TipTap |
| Dependência do provedor | Média | Médio | Porta `AiProvider`, `FakeAiProvider`, troca por configuração, disjuntor |
| Impacto no prazo do MVP 1 | Certa | Médio | +1 sprint (delivery-plan §5); stories P1 após os editores |

## Pontos em aberto
- PEND-21 — Provedor e modelo de IA (ADR-013).
- PEND-22 — Modelo de custo (incluído no plano × por uso) e limites padrão.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (métricas `cf_ai_*` e consultas de `AiGeneration`)
- [ ] Testes E2E das jornadas do épico passando (gerar → aplicar → revisar → concluir, nos quatro documentos)
- [ ] Conjunto de avaliação executado com o provedor decidido e resultado registrado na ADR-013
- [ ] Termos de uso da IA revisados pelo jurídico/DPO; inventário de dados atualizado
- [ ] Documentação e treinamento (guia do usuário) atualizados
