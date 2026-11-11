---
id: EP-027
title: "Edital"
mvp: 2
priority: P0
features: [FT-078, FT-079]
status: Especificado
---

# EP-027 — Edital

## Título
Edital

## Objetivo
Permitir que Licitações elabore, dentro do processo, a **minuta do edital** e a **minuta do contrato** a partir de template e do Termo de Referência já aprovado, sem redigitar itens, critérios e condições. A minuta tem cabeçalho tipado (modalidade, critério de julgamento, modo de disputa, regime de execução, habilitação, prazos), lotes, matriz de alocação de riscos quando aplicável e conclusão que a deixa pronta para o Jurídico e para a autoridade. Um rascunho por IA, em cadeia a partir do TR, acelera a redação, sempre com revisão humana.

## Contexto e problema
- O edital (art. 25 da Lei 14.133/2021) é o produto final da fase preparatória e hoje é redigido fora do sistema, copiando e colando do TR, com risco de divergência entre os dois. O principal concorrente já oferece a geração do edital com IA.
- DEC-201 cria o módulo `tender`: `Tender` (1:1 com o processo, com o cabeçalho tipado) e `TenderLot` (lotes com os `ProcessItem`), documentos `EDITAL` (`SystemDocumentModule.TENDER`) e `MINUTA_CONTRATO` gerados de template com `importMappings` (como TR ← ETP) e matriz de alocação de riscos (art. 22) a partir do mapa de riscos.
- **No MVP 2 só existe a minuta.** Número do edital, publicação, status `PUBLISHED`, impugnações e sessão pública ficam para o MVP 3 em diante (DEC-201); a aprovação do edital é a etapa `AUTORIZACAO_LICITACAO` (DEC-196), não uma `Approval` do documento.
- DEC-202 acrescenta o gerador `draft.tender` à camada de IA do EP-020 (`AiGeneration.targetModule = TENDER`), com os mesmos princípios: a IA não decide, nada é inventado, o que falta sai como "[a confirmar]" e há revisão humana obrigatória por seção (US-122). A matriz de riscos proposta entra só como texto, nunca grava `TenderRiskAllocation` sozinha. O provedor continua o da ADR-013 (PEND-21 segue decisão separada). O custo é o incluído no plano (DEC-203).
- A posição do edital no workflow (`MINUTA_EDITAL` entre `DOTACAO` e `JURIDICO`) é padrão semeado a validar com o piloto (DEC-196, L-04).

## Escopo
- Criação da minuta com cabeçalho tipado e documento `EDITAL`, e da `MINUTA_CONTRATO` (US-163, US-167).
- Importação de itens, critérios e condições do TR com versão de origem registrada (US-164).
- Lotes do edital sobre os itens do processo, com cobertura total quando a adjudicação é por lote (US-165).
- Matriz de alocação de riscos (art. 22) a partir do mapa de riscos (US-166).
- Conclusão da minuta com validação de completude e vínculo às versões (US-168).
- Rascunho do edital com IA (US-169).
- Aba do processo SCR-021 com edição, importação e conclusão.

## Fora de escopo
- Publicação do edital e de atos (PNCP, Diário Oficial), número do edital, status `PUBLISHED`, impugnações e sessão pública (MVP 3 em diante).
- Assinatura eletrônica da minuta (MVP 3).
- Parecer jurídico e a aprovação do edital em si (EP-025 e etapa `AUTORIZACAO_LICITACAO`).
- IA que defina critério de julgamento, modalidade, lotes ou valores; a IA escreve só texto.
- Gestão do contrato e fiscalização (MVP 4); aqui só a minuta do contrato.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Licitações | `LICITACOES` | Elaborar a minuta do edital e do contrato com cabeçalho, lotes, riscos e IA |
| Planejamento e Compras | `PLANEJAMENTO`, `COMPRAS` | Ter o TR refletido fielmente no edital |
| Consultoria externa | `CONSULTOR_EXTERNO` | Editar a minuta quando participante do processo (`TENDER_UPDATE`) |
| Jurídico | `JURIDICO` | Analisar a minuta e a minuta do contrato vinculadas por versão |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Aprovar o edital na autorização da licitação |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-078 | Minuta do edital e do contrato | US-163 ⏳, US-164 ⏳, US-165 ⏳, US-166 ⏳, US-167 ⏳, US-168 ⏳ | P0 |
| FT-079 | IA no edital | US-169 ⏳ | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-163 ⏳ | Criar a minuta do edital com cabeçalho tipado | P0 | M | 5 |
| US-164 ⏳ | Importar itens, critérios e condições do TR para o edital | P0 | M | 5 |
| US-165 ⏳ | Organizar os lotes do edital | P0 | M | 5 |
| US-166 ⏳ | Matriz de alocação de riscos do edital | P1 | M | 5 |
| US-167 ⏳ | Elaborar a minuta do contrato | P0 | M | 5 |
| US-168 ⏳ | Concluir a minuta do edital | P0 | M | 5 |
| US-169 ⏳ | Gerar o rascunho do edital com IA | P1 | L | 8 |
| **Total** | | | | **38** |

## Módulos e entidades
- Módulos: `tender` (novo); `document` (editor, versões, PDF); `ai` (gerador `draft.tender`); leitura de `process`, `term`, `risk`, `price-research`, `catalog`, `workflow` e `tenancy`; transversais `timeline`, `notification` e `audit`.
- Entidades: `Tender`, `TenderLot`, `TenderLotItem` e `TenderRiskAllocation` (donos `tender`; entities.md §4.5); `Document` `EDITAL` e `MINUTA_CONTRATO` (consumida); `ProcessItem` (consumida — `lotNumber`/`lotName` continuam como planejamento); `AiGeneration` com `targetModule = TENDER` (consumida; §5.12 e §7.11).

## Telas
- SCR-021 — Edital (minuta do edital e do contrato), `/processos/[id]/edital/[tenderId]`.
- SCR-117 — Assistente de redação com IA (painel lateral sobre a SCR-021).

## Integrações
- Internas: `document` (`TypedDocumentModule`, importação por `importMappings`, versões e PDF via Gotenberg), `ai` (fila `ai-generation`, `ContextSanitizer`, `GroundingGuard`), `workflow` (etapa `MINUTA_EDITAL`), outbox e relay, `NotificationDispatcher`, `TimelineProjector`.
- Externas: provedor de IA atrás da porta `AiProvider` (ADR-013, PEND-21 aberta); nenhuma integração de publicação no MVP 2.

## Eventos principais
- `TenderCreated`, `TenderUpdated`, `TenderImportedFromTerm`, `TenderLotsChanged`, `TenderRiskAllocationChanged`.
- `DocumentFinalized` do tipo `EDITAL` (nome especializado `TenderDraftCompleted`) e do tipo `MINUTA_CONTRATO`.
- `AiGenerationRequested`, `AiGenerationCompleted`, `AiGenerationFailed`, `AiContentApplied`, `AiContentReviewed` (do EP-020, agora com `TENDER`).

## Permissões envolvidas
- `TENDER_CREATE`, `TENDER_UPDATE`, `TENDER_SUBMIT`; `PROCESS_VIEW` para ler a minuta.
- `AI_GENERATE` (ampliada a `LICITACOES` — DEC-202) com POL-18 estendida a `TENDER`; `APPROVAL_DECIDE` na autorização da licitação (POL-23).
- Políticas: POL-02 (edição de documento, com `TENDER_UPDATE`), POL-18 e POL-23.

## Regras configuráveis
- `tender.riskMatrixValueThreshold` — valor a partir do qual a matriz de riscos é obrigatória, além das hipóteses legais do art. 22, § 3º (padrão `null`).
- Template do `EDITAL` e da `MINUTA_CONTRATO` — seções, orientações, base legal e `aiHints` por órgão.
- `ai.enabled`, `ai.monthlyTokenLimit` e `ai.userDailyRequestLimit` — IA, limites e consumo (EP-020).
- Catálogos `JUDGMENT_CRITERION` e `MODALITY` — opções do cabeçalho.
- Posição da etapa `MINUTA_EDITAL` e regra de saída na versão do workflow do tenant (EP-021).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Tempo de elaboração da minuta (criação → conclusão) | ≤ 4 dias úteis (redução ≥ 30% nos órgãos com IA) | `Document.createdAt` × `finalizedAt` do `EDITAL` |
| Minutas criadas com importação do TR | ≥ 90% | `TenderImportedFromTerm` × `TenderCreated` |
| Devoluções do Jurídico por divergência entre edital e TR | Redução ≥ 40% | Movimentos `RETURN` da etapa `JURIDICO` |
| Rascunhos de edital por IA aplicados (aplicados ÷ concluídos) | ≥ 60% | `cf_ai_generations_total{status}` |
| Valores ou prazos inventados que chegam à minuta final | 0 | Revisão humana, `GroundingGuard` e amostragem |

## Dependências
- **Depende de:** EP-001 (processo), EP-005 e EP-006 (mapa de riscos e TR de origem), EP-011 (documentos), EP-018 (templates), EP-020 (camada de IA); EP-021 (`RuleContext` v2 e a etapa `MINUTA_EDITAL`).
- **Habilita:** EP-025 (parecer sobre a minuta), EP-021 (a v2 semeada só sai com a regra de saída da US-168), EP-031 (regras sobre `tender.*`); MVP 3 (publicação do edital).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Edital divergir do TR depois da importação | Média | Alto | Versão do TR de origem registrada, aviso quando o TR muda e reimportação seletiva |
| Alucinação da IA em cláusulas e valores | Alta | Alto | Entradas só do TR, da pesquisa de preços, do mapa de riscos e do `Tender`; `GroundingGuard`; "[a confirmar]"; revisão humana obrigatória |
| Valor sigiloso vazar no edital ou na IA | Baixa | Alto | `estimatedValueDisclosed` conforme o sigilo (art. 24), `ContextSanitizer` e POL-09 |
| Modelos de edital muito variados entre órgãos | Média | Médio | Template por órgão e cabeçalho tipado; padrão semeado a validar |
| Escopo crescer para a publicação | Média | Médio | Fora de escopo explícito: só a minuta no MVP 2 (DEC-201) |

## Pontos em aberto
- PEND-21 — Provedor e modelo de IA (ADR-013): o gerador `draft.tender` roda com o `FakeAiProvider` até a decisão.
- Posição do edital no workflow (L-04): `MINUTA_EDITAL` entre `DOTACAO` e `JURIDICO` é padrão semeado a validar com o jurídico do piloto (overview §7), não pendência.
- Formato exato da importação de condições do TR para o cabeçalho e fórmulas de cobertura de lotes: a fechar no `api.md` e nos cards de story (card 9).

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados
- [ ] Testes E2E das jornadas do épico passando (criar → importar do TR → lotes e riscos → concluir; e a variante com IA)
- [ ] Conjunto de avaliação do `draft.tender` executado e registrado (revisão por seção e `GroundingGuard`)
- [ ] Documentação e treinamento (guia do usuário) atualizados
