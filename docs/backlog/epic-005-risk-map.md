---
id: EP-005
title: "Mapa de riscos"
mvp: 1
priority: P0
features: [FT-021, FT-022, FT-023]
status: Especificado
---

# EP-005 — Mapa de riscos

## Título
Mapa de riscos

## Objetivo
Dar ao órgão uma forma estruturada de identificar, avaliar, tratar e formalizar os riscos de cada processo de contratação — cumprindo a exigência de gestão de riscos da fase preparatória (Lei 14.133/2021, art. 18, §1º, X) — e produzir o documento **Mapa de Riscos** como artefato de instrução do processo, com rastreabilidade de escala, score, nível e tratamento.

## Contexto e problema
- Hoje a análise de riscos, quando existe, é feita em planilhas avulsas ou documentos externos ao processo: sem escala padronizada, sem histórico de reavaliação, sem ligação entre risco e ação de tratamento, e sem um documento formal para instruir o processo.
- A Lei 14.133/2021 trata a gestão de riscos como parte da fase preparatória da contratação; o Decreto 10.947/2022 e as boas práticas de controle interno recomendam a matriz de probabilidade × impacto (P×I) como ferramenta padrão.
- DEC-021 define o modelo de dados: `Risk` (identificação e avaliação) + `RiskTreatment` (ações preventivas/de contingência), ambos pertencentes ao processo (DEC-010). O documento `RISK_MAP` segue o modelo documental híbrido (DEC-017) e o ciclo de vida único de documentos (DEC-018): é o artefato formal cujo snapshot (`DocumentVersion`) inclui os riscos vigentes no momento da emissão.
- Escala (`risk.scale`) e faixas de nível (`risk.levelThresholds`) são configuráveis por tenant, com padrão 5×5 semeado (DEC-021), para acomodar órgãos que já usam outras metodologias de controle interno.

## Escopo
- Registro, avaliação (probabilidade × impacto) e reavaliação de riscos por processo, com código sequencial, categoria (catálogo `RISK_CATEGORY`), fase (`RiskPhase`), causa, consequência, responsável e risco residual opcional (FT-021).
- Cálculo automático de score e nível pela escala/faixas vigentes do tenant, com registro histórico (`scaleSnapshot`) a cada avaliação (FT-021).
- Cadastro e acompanhamento de ações de tratamento (prevenção/contingência), com responsável, prazo e status, e propagação do status do risco para "Em tratamento" (FT-022).
- Matriz de calor (heat map) consolidando os riscos vigentes do processo por probabilidade × impacto, com filtros (FT-023).
- Emissão do documento Mapa de Riscos (`RISK_MAP`), com validação de completude (risco sem tratamento quando Alto/Extremo), finalização/submissão à aprovação e reabertura, reaproveitando o ciclo de vida genérico de documentos (FT-023).
- Bloqueio de edição de riscos e tratamentos enquanto o Mapa de Riscos estiver finalizado/em aprovação/aprovado, até reabertura.

## Fora de escopo
- Definição do workflow e das regras de aprovação em si (reaproveita o módulo `workflow` e o ciclo de aprovações genérico de outros épicos).
- Metodologias de gestão de riscos além da matriz P×I (ex.: ISO 31000 completa, riscos quantitativos monetizados) — tratado como possível evolução pós-MVP 1.
- Notificações/alertas automáticos de prazo de tratamento vencido — a tela destaca "Atrasado" visualmente, mas o envio de notificação dedicada não está neste épico.
- Acompanhamento de riscos durante a execução contratual além da marcação de fase (`RiskPhase.CONTRACT_MANAGEMENT`) — gestão de riscos contratuais operacional é de outro épico/MVP.
- Renderização em PDF e assinatura do Mapa de Riscos — reaproveita o worker `document-render` e a assinatura (MVP 3) de outros épicos, fora deste escopo.

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Gestor de contratações | `GESTOR_CONTRATACOES` | Registra, avalia e trata riscos; emite o Mapa de Riscos |
| Planejamento | `PLANEJAMENTO` | Apoia a identificação e o tratamento de riscos na fase de estudos |
| Área requisitante | `REQUISITANTE` | Contribui com causas/consequências específicas do objeto demandado |
| Autoridade/aprovador | perfil com `RISK_MAP_SUBMIT`/aprovação de etapa | Aprova o Mapa de Riscos quando a etapa do workflow exigir |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-021 | Identificação e avaliação | US-033 | P0 |
| FT-022 | Tratamento | US-034 | P0 |
| FT-023 | Matriz e documento | US-035 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-033 | Registrar e avaliar riscos | P0 | M | 5 |
| US-034 | Gerenciar ações de tratamento de riscos | P0 | M | 5 |
| US-035 | Visualizar matriz de riscos e emitir o Mapa de Riscos | P1 | M | 5 |
| **Total** | | | | **15** |

## Módulos e entidades
- Módulos: `risk` (dono); consome `document` (ciclo de vida do `RISK_MAP`), `process` (agregado central), `catalog` (`RISK_CATEGORY`), `workflow` (regras de etapa que cobrem o tipo `RISK_MAP`), `access`, `audit`, `platform`.
- Entidades: `Risk` (dono), `RiskTreatment` (dono); `Document` (consumida — cabeçalho do `RISK_MAP`), `CatalogItem` (consumida — `RISK_CATEGORY`).

## Telas
- SCR-011 — Riscos (mapa de riscos) (`/processos/[id]/riscos`)

## Integrações
- Internas: `document` (DEC-018 — submeter/finalizar/reabrir reaproveitados de US-065), `workflow` (etapa que cobre o tipo `RISK_MAP`, permissão `RISK_MAP_SUBMIT`), `catalog` (itens de `RISK_CATEGORY`), `access`/`audit`/`platform` (outbox, idempotência).
- Externas: nenhuma neste épico.

## Eventos principais
- `RiskCreated`, `RiskAssessed`, `RiskDeleted`, `RiskTreatmentChanged`
- `DocumentCreated`, `DocumentVersionCreated`, `DocumentSubmitted`, `DocumentFinalized`, `DocumentReopened` (instâncias do tipo `RISK_MAP`)

## Permissões envolvidas
- `RISK_MANAGE` — registrar, avaliar, excluir riscos e gerenciar tratamentos.
- `RISK_MAP_SUBMIT` — concluir/submeter o Mapa de Riscos.
- Consumidas: `PROCESS_VIEW`, `DOCUMENT_REOPEN`.

## Regras configuráveis
- `risk.scale` — dimensão e rótulos da escala de probabilidade/impacto (padrão 5×5, DEC-021).
- `risk.levelThresholds` — faixas de score por nível (padrão 1–4 Baixo, 5–9 Médio, 10–16 Alto, 17–25 Extremo).

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| % de processos com Mapa de Riscos finalizado antes do encaminhamento à fase de seleção | ≥ 80% | `documents` (status por tipo) |
| % de riscos Alto/Extremo com ao menos um tratamento ativo | 100% (bloqueante na finalização) | `risks` + `risk_treatments` |
| Tempo médio entre a criação do processo e o primeiro risco registrado | ≤ 5 dias úteis | eventos `ProcessCreated` → `RiskCreated` |

## Dependências
- **Depende de:** EP-001 — Processo de contratação (US-001, agregado central e visibilidade); EP-011 — Documentos (FT-040/US-065, ciclo de vida genérico reaproveitado por FT-023); EP-017 — Tenant e estrutura organizacional (FT-057/US-104, catálogo `RISK_CATEGORY`); EP-018 — Templates de documentos (FT-058/US-110, template padrão do tipo `RISK_MAP`).
- **Habilita:** fases de seleção/contratação que exigem o Mapa de Riscos como pendência de instrução (verificação de completude do processo, fora deste épico).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Divergência entre a escala vigente e o `scaleSnapshot` histórico confundir usuários ao comparar avaliações antigas | Média | Médio | Exibir sempre a escala usada junto ao score histórico; não recalcular retroativamente (RN-RISK-04) |
| Tenants com metodologia de risco própria (fora de P×I 3–5) não se adaptarem ao modelo configurável | Baixa | Médio | `risk.scale`/`risk.levelThresholds` configuráveis (DEC-021); acompanhar feedback do piloto |
| Acoplamento incorreto entre o bloqueio de edição de riscos e o ciclo de vida do documento gerar bloqueios indevidos | Média | Alto | Regra de editabilidade (RN-RISK-09/16) coberta por testes de integração dedicados; mensagens de erro com link de reabertura |

## Pontos em aberto
- ~~PEND-15~~ — decidida em 2026-10-07: padrão 5×5 semeado (DEC-021); escala e faixas configuráveis por tenant.
- Lacuna registrada em US-033/US-034: ausência de uma política nomeada (equivalente a POL-02, mas para o sub-recurso de riscos) nas fontes canônicas de permissions.md — proposta de nova política "Edição de riscos" com ID a atribuir.
- Lacuna registrada em US-035: sufixo de routing key de eventos de documento para o módulo `RISK_MAP` (`risk_map`) assumido por analogia; e chaves de seções narrativas do template padrão do tipo `RISK_MAP` (US-110) não especificadas neste pacote.

## Definition of Done do épico
- [ ] Todas as features (FT-021, FT-022, FT-023) concluídas
- [ ] KPIs instrumentados (eventos e consultas de apoio)
- [ ] Testes E2E das jornadas do épico passando (registrar → tratar → visualizar matriz → emitir e finalizar o Mapa de Riscos → reabrir)
- [ ] Documentação e guia do usuário sobre gestão de riscos atualizados
