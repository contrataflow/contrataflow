# ADR-016 — Migração de processos em andamento entre versões de workflow

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-11-10 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-195 (migração — paga DT-02), DEC-014 (versão fixada no processo), DEC-194 (paralelismo), DEC-196 (workflow padrão v2), DEC-193 (aprovação múltipla), PEND-03 (reabertura) |
| **Documentos** | [ADR-005](adr-005-workflow-engine.md) · [risks-and-decisions.md §6](../mvp-01/risks-and-decisions.md#6-débitos-técnicos-assumidos) (DT-02) · [roadmap.md §11.3](../product/roadmap.md#113-mvp-2) |

## Contexto

- Pela DEC-014, o processo fixa a `WorkflowVersion` na criação e uma edição posterior do workflow não o afeta. No MVP 1 não há como levar um processo em andamento para uma versão nova (DT-02).
- O MVP 2 publica a versão 2 do workflow padrão com dotação, minuta do edital, jurídico e controle interno (DEC-196). Sem migração, os processos abertos durante o MVP 1 terminariam no "planejamento concluído", sem as etapas que completam a fase preparatória — e os já concluídos não teriam como seguir.
- Migrar mexe no coração do runtime: etapa ativa, responsável, prazo, aprovações pendentes, regras de saída e a narrativa da timeline. Precisa ser previsível, auditável e nunca acontecer sem alguém pedir.

## Decisão

1. **Plano explícito:** `WorkflowMigration` (origem, destino, mapa de etapas `sourceStageKey → targetStageKey`, filtro de processos, status `DRAFT` → `SIMULATED` → `RUNNING` → `COMPLETED`, ou `CANCELED`) criado pelo administrador do órgão (permissão indicativa `WORKFLOW_MIGRATE`). O mapa nasce por correspondência de `key` + `type` e é completado à mão.
2. **Simulação obrigatória**, sem efeito: gera um `WorkflowMigrationItem` por processo com a classificação:
   - `AUTOMATIC` — etapa ativa mapeada para etapa do mesmo tipo; aprovação pendente compatível (mesmos aprovadores resolvidos e mesma política); nenhuma regra `BLOCKING` da etapa de destino já violada de forma a regredir o processo;
   - `NEEDS_DECISION` — etapa removida ou de tipo diferente; aprovação pendente incompatível; processo com ramos paralelos ativos; processo `COMPLETED` da v1 do padrão (continuação da fase preparatória);
   - `BLOCKED` — `CANCELED`/`PUBLISHED`, outra migração em curso, processo com dados inválidos para o destino.
3. **Decisão humana por item** em `NEEDS_DECISION`: escolher a etapa de destino (ou excluir o processo), com justificativa registrada.
4. **Execução assíncrona** na fila `maintenance`, **um processo por transação**, idempotente por item, com trava consultiva do processo:
   - `Process.workflowVersionId` passa ao destino;
   - a etapa ativa fecha com `ProcessStageStatus` **`MIGRATED`** e a etapa de destino abre preservando unidade, responsável e `dueAt` (o prazo não recomeça);
   - aprovações pendentes compatíveis continuam; as incompatíveis são canceladas com motivo e solicitadas de novo pela etapa de destino;
   - `ProcessMovement` com a ação **`MIGRATE`**, entrada na timeline ("Processo migrado da versão N para a versão M"), auditoria `process.workflow_migrate` com o mapa aplicado, e evento de domínio de migração no outbox.
5. **Continuação dos processos concluídos no MVP 1:** um processo `COMPLETED` na v1 do padrão pode ser migrado para a v2 entrando em `DOTACAO` (sempre `NEEDS_DECISION`); o status volta a `IN_PROGRESS` só por esse caminho. A reabertura genérica (PEND-03) continua fora.
6. **Sem reversão automática.** Voltar exige outra migração (destino → origem), sujeita às mesmas regras.
7. **Relatório da migração:** por item — classificação, decisão, resultado, erro —, exportável e auditado.

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Não migrar: só processos novos usam a v2 | Zero risco no runtime | Processos abertos no MVP 1 nunca completam a fase preparatória; o piloto redigita processos | **Rejeitada:** DT-02 é pré-requisito do MVP 2 |
| Migração automática ao publicar a versão | Simples para o usuário | Muda processos sem ninguém pedir; casos ambíguos decididos pela máquina | **Rejeitada:** contra a DEC-014 e o princípio de ação humana explícita |
| Editar a versão publicada "por baixo" | Nenhuma ferramenta nova | Quebra a imutabilidade e o `definitionHash` (DEC-084) | **Rejeitada** |
| **Plano + simulação + decisão humana nos ambíguos + execução por processo** | Previsível, auditável, recuperável item a item | Ferramenta nova a construir e testar | **Adotada** |

## Consequências

**Positivas**
- Os pilotos levam os processos do MVP 1 para a fase preparatória completa sem redigitar.
- Cada processo migrado conta a própria história na timeline e na auditoria.
- A mesma ferramenta serve a qualquer nova versão de workflow do tenant, não só à v2 do padrão.

**Negativas**
- Mais um estado de etapa (`MIGRATED`) e uma ação (`MIGRATE`) que consultas, indicadores e a caixa de tarefas precisam conhecer.
- Os casos `NEEDS_DECISION` dão trabalho manual ao administrador.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Processo migrado para etapa errada | Simulação obrigatória, revisão do mapa, decisão humana nos ambíguos, migração de volta possível |
| Falha no meio de um lote | Transação por processo e idempotência por item; reexecução retoma só os pendentes |
| Corrida com tramitação em curso | Trava consultiva por processo e `expectedStageId`; item fica `NEEDS_DECISION` se a etapa mudou depois da simulação |
| Indicadores contarem a migração como passagem de etapa | Fatos de etapa marcam `MIGRATED` e não contam como devolução nem como conclusão (ADR-014) |

## Critérios de revisão

- Migrações frequentes entre versões com muitas diferenças → avaliar mapeamento por regras (JSON Logic) em vez de mapa fixo.
- Paralelismo aninhado no futuro → rever a classificação `NEEDS_DECISION` para ramos.

## Referências

- Internas: DEC-014, DEC-084, DEC-193, DEC-194, DEC-195, DEC-196; DT-02; PEND-03; [ADR-005](adr-005-workflow-engine.md); [ADR-014](adr-014-indicators-read-model.md).
