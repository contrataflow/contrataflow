# ADR-014 — Read model de indicadores e gargalos

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-11-10 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-206 (indicadores em read model), DEC-088 (dashboard sobre views), DEC-024 (visibilidade), DEC-030 (sigilo do orçamento), DEC-160/161 (outbox), DEC-197 (PCA), DEC-205 (SLA) |
| **Documentos** | [roadmap.md §4](../product/roadmap.md#4-mvp-2--governança-e-controle) (Indicadores, Gargalos; SCR-027, SCR-028) · [mvp-02/overview.md](../mvp-02/overview.md) · [risks-and-decisions.md §12](../mvp-01/risks-and-decisions.md#12-validação-para-iniciar-o-mvp-2) |

## Contexto

- O MVP 2 entrega relatórios (SCR-027), relatório detalhado (SCR-028) e análise de gargalos: tempo de ciclo, devoluções, cumprimento de prazo, volume e valor por secretaria e modalidade, execução do PCA, tempo por etapa, unidade e responsável, filas, envelhecimento e comparação entre períodos.
- Essas perguntas varrem a história inteira dos processos (`ProcessStage`, `ProcessMovement`, `Approval`), com janelas de meses ou do exercício. O dashboard do MVP 1 (DEC-088) já agrega sobre views `security_invoker` das tabelas transacionais, com cache de 60 s — serve para contadores do dia a dia, não para séries históricas e comparações.
- Consultas analíticas pesadas sobre as tabelas transacionais disputam I/O e trava com a tramitação, e o roadmap (§4.10) registra o risco de "relatórios pesados sobre o banco transacional".
- As regras de acesso continuam valendo: isolamento por tenant (RLS), visibilidade de processos (DEC-024) e mascaramento do orçamento sigiloso (DEC-030).

## Decisão

1. **Módulo `analytics` dono de um read model próprio**, em tabelas de fatos com `tenant_id` e RLS como todo o resto (DEC-080, DEC-082):
   - `analytics_stage_facts` — uma linha por passagem de etapa (entrada, saída, duração em dias úteis e corridos, unidade, responsável, se houve devolução, se venceu o prazo, pausas de SLA);
   - `analytics_process_facts` — uma linha por processo com a situação corrente e os marcos (abertura, aprovação do DFD, conclusão, valor estimado, modalidade, secretaria, item do PCA, quantidade de devoluções);
   - `analytics_pca_item_facts` — execução do PCA por item (previsto × vinculado × concluído).
2. **Alimentação por eventos do outbox** (DEC-161): um consumidor no worker projeta os eventos de tramitação, aprovação, documento, PCA e SLA nas tabelas de fatos, idempotente por `eventId`. Defasagem-alvo: até 5 minutos; a tela mostra "dados atualizados em …".
3. **Reconstrução e reconciliação:** job noturno por tenant recalcula os fatos a partir das tabelas transacionais (fora do horário de uso) e corrige divergências; o mesmo job serve para reconstruir tudo depois de mudança de definição de indicador.
4. **Agregados em visões materializadas** sobre as tabelas de fatos (por mês, secretaria, modalidade, etapa), atualizadas com `REFRESH MATERIALIZED VIEW CONCURRENTLY` em agenda; relatórios leem as visões e, para o detalhamento, as tabelas de fatos.
5. **Nenhum relatório consulta `ProcessStage`/`ProcessMovement` diretamente em produção.** O dashboard da DEC-088 continua como está.
6. **Segurança na leitura:** agregados filtrados pelo escopo da permissão de relatório (tenant, órgão ou unidades); detalhamento por processo aplica `buildVisibilityPredicate` (DEC-024) sobre os fatos; valores de processos com orçamento sigiloso entram mascarados para quem não tem a permissão de sigilo (somatórios sem esses valores e com a indicação "inclui valores sigilosos não exibidos").
7. **Exportação** CSV/XLSX pela fila de exportações, auditada (`report.export`).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| Consultas diretas nas tabelas transacionais (como o dashboard) | Nada novo para manter; sempre atual | Varreduras históricas competem com a tramitação; índices transacionais não servem a recortes analíticos; difícil de escalar | **Rejeitada:** risco explícito do roadmap §4.10 |
| Só visões materializadas sobre as tabelas transacionais | Pouca peça nova | O refresh relê todo o histórico transacional; sem granularidade de fato por passagem; difícil de reconciliar incrementalmente | **Rejeitada** como solução única; usada como camada de agregação |
| Réplica de leitura do PostgreSQL | Isola a carga sem mudar o modelo | Continua consultando o modelo transacional, sem os fatos derivados (dias úteis, pausas, devoluções); custo de infraestrutura; RLS e visibilidade iguais de qualquer forma | **Adiada:** opção de escala quando o volume justificar |
| Data warehouse externo (ex.: Redshift, BigQuery) | Escala analítica | Nova infraestrutura, dados fora do banco com RLS, sincronização e LGPD; desproporcional ao volume dos pilotos | **Rejeitada no MVP 2** |
| **Tabelas de fatos por eventos + visões materializadas no próprio PostgreSQL** | Isola as consultas, granularidade certa, mesma segurança (RLS), reconstruível | Defasagem de minutos; projeção e reconciliação para manter | **Adotada** |

## Consequências

**Positivas**
- Relatórios e gargalos com custo previsível, sem pesar na tramitação.
- Os fatos guardam medidas derivadas (dias úteis, pausas de SLA, devoluções) calculadas uma vez.
- O mesmo read model sustenta o cumprimento de SLA (DEC-205) e a execução do PCA (DEC-197).

**Negativas**
- Consistência eventual: um movimento recente pode levar alguns minutos para aparecer nos relatórios.
- Duas representações dos mesmos fatos (transacional e analítica) — exige teste de reconciliação.
- Mudança de definição de indicador exige reconstrução dos fatos.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Projeção perde evento ou aplica fora de ordem | Idempotência por `eventId`, projeção por chave natural (passagem de etapa) e reconciliação noturna com relatório de divergências |
| Vazamento entre tenants ou de processos não visíveis no relatório | RLS nas tabelas de fatos; predicado de visibilidade no detalhamento; casos na suíte de tenant leak e nos testes de autorização |
| Orçamento sigiloso exposto por agregação (diferença entre somas) | Mascaramento por linha antes de agregar; somatórios sem valores sigilosos para quem não tem a permissão |
| Refresh das visões competindo com a tramitação | `CONCURRENTLY`, agenda fora do pico e meta de duração monitorada |

## Critérios de revisão

- Volume de um tenant tornar o refresh das visões lento (> 5 min) → particionar fatos por exercício ou mover a leitura para réplica.
- Pedido de indicadores em tempo real estrito → avaliar projeção síncrona de fatos específicos.
- Demanda de BI externo pelos órgãos → avaliar exportação programada ou conector, sem expor o banco.

## Referências

- Internas: DEC-024, DEC-030, DEC-088, DEC-161, DEC-197, DEC-205, DEC-206; [ADR-004](adr-004-outbox-events.md); [ADR-002](adr-002-multi-tenancy.md).
- Lei 14.133/2021, art. 11, parágrafo único (governança das contratações).
