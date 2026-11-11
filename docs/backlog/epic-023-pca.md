---
id: EP-023
title: "PCA"
mvp: 2
priority: P1
features: [FT-068, FT-069, FT-070, FT-071]
status: Especificado
---

# EP-023 — PCA

## Título
PCA

## Objetivo
Dar ao órgão o plano de contratações anual (PCA) dentro da plataforma: elaborado ou importado por planilha, aprovado pela autoridade competente, vinculado aos DFDs e aos processos, acompanhado na execução e exportado para divulgação. As referências textuais ao PCA gravadas no MVP 1 são reconciliadas com os itens do plano aprovado, com relatório e conciliação manual assistida.

## Contexto e problema
- O art. 12, VII, da Lei 14.133/2021 prevê o plano de contratações anual, e o art. 12, § 1º, exige a sua divulgação em sítio oficial. O critério de saída do MVP 2 pede um PCA elaborado, aprovado e vinculado aos DFDs por pelo menos um órgão (roadmap §4.8).
- No MVP 1 não existe entidade PCA: `Process` e `Dfd` guardam só `pcaStatus`, `pcaYear`, `pcaItemCode` e `pcaJustification` (DEC-029). Sem o plano, nada impede um item de ser contratado duas vezes nem permite comparar o previsto com o contratado.
- A DEC-197 cria o módulo `pca` com `Pca` e `PcaItem`, a aprovação por `Approval` de assunto `PCA`, o vínculo por `pcaItemId` (FK composta com tenant) e o job de reconciliação.
- Os órgãos pequenos já mantêm o plano em planilha: a importação com validação por linha evita a redigitação. O calendário e a estrutura do plano entram como padrão configurável (overview §7).
- Lacuna L-07: `CONSULTOR_EXTERNO` não acessa o PCA no MVP 2; a participação da DEC-036 continua só por processo.
- Sigilo: `PcaItem.plannedValue` de itens vinculados a processo com orçamento sigiloso segue a POL-09 na visão por processo (DEC-030).

## Escopo
- Módulo `pca`, entidades `Pca`, `PcaItem`, `PcaReconciliationRun` e `PcaReconciliationEntry`.
- Plano por órgão e exercício, com itens (secretaria, objeto, categoria, valor previsto, mês previsto, responsável, situação) e totais desnormalizados (US-138).
- Importação por planilha CSV/XLSX com validação por linha e relatório de rejeições (US-139).
- Aprovação pela autoridade (`ApprovalSubjectType` `PCA`) e revisão do plano aprovado com nova versão e histórico (US-140, US-141).
- Vínculo `pcaItemId` em DFD e processo, seletor `/pca-items/lookup` e propagação DFD para processo (US-142).
- Job de reconciliação das referências textuais, relatório e conciliação manual assistida (US-143).
- Acompanhamento da execução: previsto x processos vinculados por item, secretaria e categoria (US-144).
- Exportação para divulgação (art. 12, § 1º) (US-145).
- Regras de negócio do épico: `RN-PCA-NN`, distribuídas nas quatro features.

## Fora de escopo
- Publicação automática do PCA no PNCP ou em sítio oficial (MVP 3; PEND-16).
- Acesso da consultoria externa ao PCA (L-07).
- Consolidação do PCA de vários órgãos do tenant em um plano único; o plano é por órgão e exercício.
- Consulta a sistemas de planejamento externos (PCA do PNCP) e geração do plano por IA.
- Painéis analíticos de execução do PCA: ficam no EP-028 (que lê os eventos deste épico).

## Personas
| Persona | Perfil | Interesse no épico |
|---|---|---|
| Planejamento | `PLANEJAMENTO` | Elaborar, importar, revisar e acompanhar o plano; vincular DFDs; conciliar referências |
| Área requisitante | `REQUISITANTE` | Escolher o item do plano ao registrar a necessidade (DFD) |
| Autoridade competente | `AUTORIDADE_COMPETENTE` | Aprovar o PCA e as revisões |
| Gestor de contratações | `GESTOR_CONTRATACOES` | Ver a execução do plano por secretaria e categoria |
| Auditor / Controle interno | `AUDITOR`, `CONTROLE_INTERNO` | Rastrear versões, aprovação, reconciliação e exportações; exportar o plano |
| Administrador do órgão | `ADMIN_ORGAO` | Configurar o calendário e a regra de vínculo obrigatório |

## Features
| Feature | Título | Stories | Prioridade |
|---|---|---|---|
| FT-068 | Elaboração do PCA | US-138, US-139 | P1 |
| FT-069 | Aprovação e revisão do PCA | US-140, US-141 | P1 |
| FT-070 | Vínculo e reconciliação | US-142, US-143 | P1 |
| FT-071 | Acompanhamento e divulgação | US-144, US-145 | P1 |

## Stories
| Story | Título | Prioridade | Estimativa | Pontos |
|---|---|---|---|---|
| US-138 | Criar o plano anual e manter os itens do PCA | P1 | L | 8 |
| US-139 | Importar itens do PCA por planilha | P1 | M | 5 |
| US-140 | Enviar o PCA para aprovação e decidir | P1 | M | 5 |
| US-141 | Revisar o PCA aprovado com nova versão | P1 | M | 5 |
| US-142 | Vincular DFD e processo a item do PCA | P1 | M | 5 |
| US-143 | Reconciliar as referências textuais ao PCA e conciliar manualmente | P1 | L | 8 |
| US-144 | Acompanhar a execução do PCA | P1 | M | 5 |
| US-145 | Exportar o PCA para divulgação | P1 | S | 2 |
| **Total** | | | | **43** |

## Módulos e entidades
- Módulos:
  - `pca` (novo), dono do plano, dos itens e da reconciliação;
  - `approval`, que decide a aprovação de assunto `PCA` (`ApprovalSubjectHandler`);
  - `process` e `dfd`, que guardam `pcaItemId` e `pcaLinkStatus` e consomem a porta `PcaLinkTarget`;
  - `catalog` (`PCA_CATEGORY`), `files` (planilha e exportações), `tenancy`, e os transversais `timeline`, `notification`, `audit` e `platform` (fila e outbox).
- Entidades: `Pca`, `PcaItem`, `PcaReconciliationRun`, `PcaReconciliationEntry` (dono `pca`); `Process.pcaItemId`/`pcaLinkStatus`, `Dfd.pcaItemId`/`pcaLinkStatus`; `Approval.pcaId` (`processId` nulo); `Attachment` com `targetType = PCA`; enums `PcaPlanStatus`, `PcaItemStatus`, `PcaLinkStatus`, `PcaReconciliationOutcome`, `PcaReconciliationRunStatus`.

## Telas
- SCR-018 — PCA: plano, itens, aprovação, execução e reconciliação (`/pca` e `/pca/[pcaId]`).
- SCR-005 — Novo processo e SCR-007 — DFD: seleção do item do plano.
- SCR-006 — Detalhe do processo: item vinculado e situação do vínculo.
- SCR-014 e SCR-015 — Aprovações: decisão sobre o PCA.
- SCR-041 — Configurações gerais: calendário do plano e vínculo obrigatório.

## Integrações
- Nenhuma externa. Importação por planilha (CSV/XLSX) e exportação para divulgação; a publicação automática chega no MVP 3.
- Internas: fila e outbox (importação e reconciliação assíncronas), `ApprovalSubjectHandler`, `NotificationDispatcher`, `TimelineProjector` e armazenamento de arquivos.

## Eventos principais
- `PcaCreated`, `PcaRevisionCreated`, `PcaImported`, `PcaItemChanged`, `PcaStatusChanged` (e `PcaApproved`), `PcaReconciliationCompleted`, `PcaReferenceConciliated`.
- Do módulo `approval`: `ApprovalRequested`, `ApprovalCompleted`, `ApprovalReturned`, `ApprovalRejected` com `processId` nulo.

## Permissões envolvidas
- `PCA_VIEW`, `PCA_MANAGE`, `PCA_SUBMIT`, `PCA_RECONCILE`, `PCA_EXPORT` (novas; POL-22).
- `APPROVAL_DECIDE` (autoridade, já existente); `DFD_UPDATE` e `PROCESS_UPDATE` (selecionar o item via `/pca-items/lookup`, capacidade implícita).
- Escopos: `PCA_VIEW` com escopo de unidade vê só os itens das suas unidades; criar o plano, revisar, importar e enviar exigem escopo `ORGANIZATION` ou `TENANT`.

## Regras configuráveis
- `pca.elaborationDeadline` — calendário do plano (padrão: 30/06 do exercício anterior; a validar com o piloto).
- `pca.requireLinkForPlanned` — com `true`, DFD com `pcaStatus = PLANNED` só conclui com `pcaItemId` (padrão `false`).
- Catálogo `PCA_CATEGORY` (semeado: material, serviço, obra, serviço de engenharia, solução de TIC).
- Matriz de perfis para as permissões `PCA_*`.

## Métricas de sucesso (KPIs)
| Métrica | Meta inicial | Fonte |
|---|---|---|
| Órgãos piloto com PCA do exercício aprovado | 1 ou mais até o fim do UAT (critério de saída) | `PcaStatusChanged` `APPROVED` |
| DFDs e processos novos vinculados a item do PCA, quando planejados | ≥ 90% em 3 meses | `Process.pcaLinkStatus` = `LINKED` ÷ `pcaStatus` = `PLANNED` |
| Referências textuais resolvidas na reconciliação | ≥ 85% resolvidas automaticamente; o restante conciliado em até 30 dias | `PcaReconciliationRun` (`linkedCount`, `unresolvedCount`) |
| Itens importados sem retrabalho | ≥ 90% das linhas aceitas na primeira importação | `PcaImported` (`rowsRead`, `rowsRejected`) |
| Importação de 500 linhas | p95 ≤ 30 s | métrica da fila de importação |
| Execução do plano visível ao gestor | Valor previsto x vinculado disponível para 100% dos itens aprovados | `PcaItem.linkedProcessesCount` |

## Dependências
- **Depende de:**
  - EP-001 e EP-002 — processo e DFD, que recebem o vínculo;
  - EP-008 — aprovações (assunto `PCA`);
  - EP-015 — worker e outbox;
  - EP-016 e EP-017 — permissões e configurações;
  - catálogos e arquivos do MVP 1 (EP-004 e EP-011).
- **Habilita:** EP-028 (execução do PCA nos indicadores); MVP 3 (publicação automática do plano).

## Riscos técnicos e de negócio
| Risco | Probabilidade | Impacto | Mitigação |
|---|---|---|---|
| Referências textuais não resolvidas na reconciliação | Alta | Médio | Relatório de reconciliação, candidatos por similaridade e conciliação manual assistida (roadmap §4.10) |
| Planilhas dos órgãos com leiaute muito diverso | Alta | Médio | Validação por linha, relatório de rejeições, modelo de planilha baixável; mapeamento de colunas detalhado no card de API |
| Aprovação de revisão desalinhando vínculos já feitos | Média | Alto | Reapontamento por `code` estável na revisão; item sem correspondente entra no relatório como `UNRESOLVED` |
| Valor previsto de item vinculado a processo sigiloso exposto | Baixa | Alto | POL-09 na visão por processo; testes de tenant leak e de sigilo |
| Concorrência entre edição do plano e aprovação | Média | Médio | Uma versão em elaboração por exercício; plano aprovado não aceita edição de itens |

## Pontos em aberto
- Estrutura e calendário do PCA (um plano por órgão e exercício; elaboração até o fim do primeiro semestre do exercício anterior): padrão semeado, a validar com o piloto no UAT (overview §7).
- Leiaute da planilha de importação e contrato de `/pca-items/lookup`: a fixar no `api.md` e nas telas do MVP 2 (card 9).
- Sementes do catálogo `PCA_CATEGORY` e eventual alinhamento com classificações do PNCP: a confirmar com o piloto.
- PEND-16 (publicação no PNCP) segue para o MVP 3.

## Definition of Done do épico
- [ ] Todas as features concluídas
- [ ] KPIs instrumentados (eventos `Pca*`, `PcaReconciliationRun` e `Process.pcaLinkStatus`)
- [ ] Testes E2E das jornadas do épico passando (elaborar ou importar, aprovar, vincular, reconciliar, revisar, exportar)
- [ ] Reconciliação executada sobre os dados do piloto, com relatório entregue
- [ ] Testes de isolamento (tenant leak) e de escopo por unidade do PCA passando
- [ ] Documentação e treinamento (guia do usuário) atualizados
