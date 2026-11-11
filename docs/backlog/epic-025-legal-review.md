---
id: EP-025
title: "Jurídico"
mvp: 2
priority: P0
features: [FT-073, FT-074, FT-075]
status: Especificado
---

# EP-025 — Jurídico

## Título
Jurídico

## Objetivo
Levar a análise jurídica do art. 53 da Lei 14.133/2021 para dentro do processo: uma fila priorizada por critérios objetivos, análise sobre as versões exatas dos documentos, diligência com devolução e retomada, parecer com ressalvas rastreáveis e situação conclusiva escolhida pelo procurador. Hipóteses de dispensa configuradas pelo órgão (art. 53, § 5º) e rascunho do parecer assistido por IA, sem que a IA sugira a conclusão.

## Contexto e problema
- O art. 53 exige o controle prévio de legalidade, mediante análise jurídica da contratação. Hoje a etapa jurídica é uma tarefa genérica no MVP 1: sem fila, sem vínculo do parecer com as versões analisadas e sem rastreio de diligências ou ressalvas (roadmap §3.2).
- A DEC-199 cria `LegalReview` por processo e rodada, com as seis situações do produto (`PENDING`, `IN_REVIEW`, `DILIGENCE`, `FAVORABLE`, `FAVORABLE_WITH_RESERVATIONS`, `UNFAVORABLE`) mais `WAIVED` e `CANCELED`, e `LegalReviewDocument` com as versões exatas analisadas.
- A DEC-196 posiciona `JURIDICO` depois de `DOTACAO` e `MINUTA_EDITAL`, e antes de `CONTROLE_INTERNO` (L-04, a validar com o jurídico do piloto). O jurídico pode devolver (`RETURN`) para qualquer etapa já percorrida e retoma a mesma análise quando o processo volta; o prazo fica pausado durante a diligência (DEC-205).
- O parecer é **não vinculante**: `UNFAVORABLE` não bloqueia por si, mas prosseguir exige motivação da autoridade na etapa seguinte (regra `WARNING` com reconhecimento registrado — ADR-008).
- A DEC-202 acrescenta o gerador `draft.legal_opinion` à camada de IA do EP-020: a IA nunca propõe a conclusão (favorável, com ressalvas, desfavorável); a seção de conclusão sai como [a confirmar] e a situação é escolhida pelo procurador. O custo está incluído no plano, com limites por órgão (DEC-203).
- Segregação de funções (POL-19): quem elabora o processo não analisa; o parecer em elaboração só é lido por quem o conduz (POL-24).

## Escopo
- Módulo `legal-review` e entidades `LegalReview`, `LegalReviewDocument`, `LegalReviewDiligence` e `LegalReviewReservation`.
- Abertura automática da análise ao entrar em `JURIDICO` e fila priorizada (SCR-019) por critérios objetivos configuráveis (US-149).
- Distribuição pelo chefe da assessoria jurídica (US-150).
- Configuração dos critérios da fila e das hipóteses de dispensa (SCR-120, US-151).
- Análise sobre versões exatas, com comparação entre rodadas (US-152).
- Diligência com `RETURN` do processo, prazo e lembretes, e retomada da análise (US-153).
- Parecer `PARECER_JURIDICO` no editor, com ressalvas como itens rastreáveis (US-154).
- Conclusão com a situação escolhida por pessoa (US-155) e dispensa por hipótese configurada (US-156).
- Rascunho do parecer por IA, em cadeia, sem propor a conclusão (US-157).
- Regras do épico: `RN-LGL-NN`.

## Fora de escopo
- Manifestação do Controle Interno (EP-026) e minuta do edital (EP-027); a IA do edital (`draft.tender`) pertence ao EP-027.
- Assinatura eletrônica do parecer (MVP 3) e integração com sistemas de procuradoria.
- IA que conclua, resuma o desfecho ou escolha a situação do parecer; assistente conversacional (MVP 5).
- Painéis analíticos do jurídico (EP-028) e a pausa de SLA na diligência em si (EP-030, que lê o evento deste épico).
- Jurisprudência, pesquisa de precedentes e minutas-padrão compartilhadas entre órgãos.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Jurídico / procurador | `JURIDICO` | Receber a fila, analisar, pedir diligência, elaborar o parecer e concluir |
| Chefe da assessoria jurídica | `JURIDICO` com titularidade da unidade | Distribuir análises e acompanhar a fila |
| Planejamento e Compras | `PLANEJAMENTO`, `COMPRAS` | Atender a diligência e as ressalvas |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Ler o parecer e motivar a decisão diante de parecer desfavorável |
| Administrador do órgão | `ADMIN_ORGAO` | Configurar critérios da fila e hipóteses de dispensa |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Rastrear versões analisadas, diligências, ressalvas e uso de IA |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-073 | Fila jurídica priorizada | US-149 ⏳, US-150 ⏳, US-151 ⏳ | P0 |
| FT-074 | Análise, diligência e parecer | US-152 ⏳, US-153 ⏳, US-154 ⏳, US-155 ⏳, US-156 ⏳ | P0 |
| FT-075 | IA no parecer jurídico | US-157 ⏳ | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-149 ⏳ | Abrir a análise jurídica e fila priorizada | P0 | L | 8 |
| US-150 ⏳ | Distribuir análises na assessoria jurídica | P0 | S | 2 |
| US-151 ⏳ | Configurar critérios da fila e hipóteses de dispensa | P0 | M | 5 |
| US-152 ⏳ | Conduzir a análise jurídica sobre versões exatas | P0 | M | 5 |
| US-153 ⏳ | Pedir diligência e retomar a análise | P0 | L | 8 |
| US-154 ⏳ | Elaborar o parecer jurídico e registrar ressalvas | P0 | M | 5 |
| US-155 ⏳ | Concluir a análise com a situação conclusiva | P0 | M | 5 |
| US-156 ⏳ | Dispensar a análise jurídica por hipótese configurada | P0 | M | 5 |
| US-157 ⏳ | Gerar o rascunho do parecer jurídico com IA | P1 | L | 8 |
| **Total** | | | | **51** |

## Módulos e entidades
- Módulos:
  - `legal-review` (novo), dono da análise, das rodadas, diligências e ressalvas;
  - `document`, com o tipo `PARECER_JURIDICO` e o `SystemDocumentModule` `LEGAL_OPINION`;
  - `process` e `workflow` (etapa `JURIDICO`, devolução, `StageLifecycleListener`);
  - `ai` (gerador `draft.legal_opinion`), leitura de `budget`, `tender` e demais documentos;
  - transversais `timeline`, `notification`, `audit` e `platform`.
- Entidades: `LegalReview`, `LegalReviewDocument`, `LegalReviewDiligence`, `LegalReviewReservation` (dono `legal-review`); `Document` `PARECER_JURIDICO`; `AiGeneration` com `targetModule = LEGAL_OPINION`; catálogo `LEGAL_WAIVER_HYPOTHESIS`; enums `LegalReviewStatus` e `LegalReservationStatus`.

## Telas
- SCR-019 — Jurídico: fila priorizada e painel de análise (`/juridico` e `/juridico/[reviewId]`).
- SCR-120 — Configuração da análise jurídica (`/admin/juridico`).
- SCR-006 — Detalhe do processo: situação da análise, diligências e ressalvas.
- SCR-117 — Assistente de redação com IA, sobre o editor do parecer.
- SCR-013 — Caixa de tarefas: etapa `JURIDICO`.

## Integrações
- Provedor de IA externo atrás da porta `AiProvider` (ADR-013, pendente — PEND-21), o mesmo do EP-020.
- Internas: fila e outbox, job `deadlines` (lembretes de diligência), `NotificationDispatcher`, `TimelineProjector`, renderização do PDF do parecer.

## Eventos principais
- `LegalReviewOpened`, `LegalReviewAssigned`, `LegalReviewStarted`, `LegalReviewDiligenceRequested`, `LegalReviewDiligenceReminderDue`, `LegalReviewResumed`, `LegalReviewConcluded`, `LegalReviewWaived`, `LegalReviewCanceled`, `LegalReservationResolved`.
- `DocumentFinalized` de `PARECER_JURIDICO` (nome do produto: `LegalOpinionIssued`); eventos de IA do EP-020 para o gerador `draft.legal_opinion`.

## Permissões envolvidas
- `LEGAL_REVIEW_VIEW`, `LEGAL_REVIEW_MANAGE`, `LEGAL_REVIEW_CONCLUDE`, `LEGAL_REVIEW_WAIVE`, `LEGAL_REVIEW_CONFIGURE` (novas; POL-19, POL-24, POL-26).
- `PROCESS_ASSIGN` no escopo da unidade jurídica (distribuição); `PROCESS_RETURN` (devolução na diligência).
- `AI_GENERATE` mais `LEGAL_REVIEW_MANAGE` (POL-18 estendida); `PROCESS_VIEW_CONFIDENTIAL_BUDGET` (valores sigilosos).

## Regras configuráveis
- `legalReview.queueCriteria` — fatores, pesos e direção da fila (padrão: prazo da etapa, urgência, valor estimado e data de entrada).
- `legalReview.diligenceDueBusinessDays` (padrão 10) e `legalReview.diligenceReminderBusinessDays` (padrão 2).
- Catálogo `LEGAL_WAIVER_HYPOTHESIS` — hipóteses de dispensa; nenhuma ativa por padrão.
- `ai.enabled`, `ai.monthlyTokenLimit` e `ai.userDailyRequestLimit` — IA do parecer.
- Template `PARECER_JURIDICO` do órgão (seções e orientações).
- Ordem entre Jurídico e Controle Interno na versão do workflow (DEC-194, DEC-196).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo médio de análise jurídica (entrada na fila a conclusão) | ≤ 10 dias úteis, com pausa na diligência | `LegalReviewOpened` x `LegalReviewConcluded` |
| Análises concluídas dentro do prazo da etapa | ≥ 80% | `ProcessStage.dueAt` e SLA pausado |
| Diligências atendidas no prazo sugerido | ≥ 75% | `LegalReviewDiligence.dueAt` x `answeredAt` |
| Pareceres vinculados às versões exatas analisadas | 100% | `LegalReviewDocument` |
| Redução do tempo de elaboração do parecer com IA | ≥ 30% frente aos pareceres sem IA | `Document.createdAt` x `finalizedAt` por proveniência |
| Conclusões propostas pela IA | 0 | `AiGeneration.output` e `GroundingGuard` |

## Dependências
- **Depende de:**
  - EP-008 — tramitação e devolução;
  - EP-011 — documentos, versões e PDF;
  - EP-016 e EP-017 — permissões e configurações;
  - EP-018 — templates do órgão;
  - EP-020 — camada de IA e governança;
  - EP-021 — versão 2 do workflow, `RuleContext` v2 e pausa de SLA na diligência (`pauseSlaWhileReturned`);
  - EP-024 e EP-027 — dotação e minuta do edital como entradas da análise.
- **Habilita:** EP-026 (manifestação sobre a instrução completa, inclusive o parecer); EP-027 (aprovação do edital com o parecer); EP-030 (pausa de SLA na diligência); EP-028 (indicadores do jurídico).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Práticas muito diferentes entre Procuradorias | Alta | Médio | Critérios, hipóteses de dispensa e modelo de parecer configuráveis; validação no UAT (roadmap §4.10) |
| Ordem entre Jurídico, Controle Interno e edital contestada pelo piloto | Média | Médio | Ordem configurável por tenant (DEC-194, DEC-196) |
| IA sugerir a conclusão do parecer | Baixa | Alto | Seção de conclusão sempre [a confirmar] (`DECISION`); `GroundingGuard` rejeita saída com situação conclusiva; situação escolhida só por pessoa |
| Parecer analisar versão desatualizada dos documentos | Média | Alto | `LegalReviewDocument` com versões exatas por rodada; nova rodada compara versões |
| Dispensa indevida da análise | Baixa | Alto | Hipótese ativa com condição verdadeira, justificativa, ato da autoridade jurídica máxima e auditoria (POL-26) |
| Vazamento de rascunho do parecer ou de orçamento sigiloso | Baixa | Alto | POL-24 e POL-09; insumos de IA sem valores sigilosos; testes de tenant leak |
| Custo e LGPD da IA | Média | Médio | Opt-in, limites por órgão, `ContextSanitizer`, ADR-013 |

## Pontos em aberto
- Modelo de parecer jurídico, critérios de prioridade da fila e hipóteses de dispensa: padrões semeados, "a validar com o piloto" (overview §7; DEC-196 a validar com o jurídico do piloto).
- PEND-21 — provedor e modelo de IA (ADR-013) continua decisão separada e vale para o `draft.legal_opinion`.
- Contratos de API, estados de tela da fila e do painel de análise: a fixar no `api.md` e nas telas do MVP 2 (card 9).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (eventos `LegalReview*`, `LegalReviewDocument` e métricas `cf_ai_*`)
- [ ] Testes E2E das jornadas do épico passando (fila, análise, diligência com retomada, parecer, conclusão, dispensa e rascunho por IA com o `FakeAiProvider`)
- [ ] Bateria de autorização das POL-19, POL-24 e POL-26 e testes de tenant leak passando
- [ ] Conjunto de avaliação do `draft.legal_opinion` executado e registrado na ADR-013
- [ ] Modelo de parecer e termos de uso da IA revisados pelo jurídico do piloto
- [ ] Documentação e treinamento (guia do procurador) atualizados
