---
id: FT-025
title: "Importação do ETP"
epic: EP-006
mvp: 1
priority: P0
stories: [US-037]
status: Especificada
---

# FT-025 — Importação do ETP

## Título
Importação do ETP

## Épico
EP-006 — Termo de Referência

## Descrição
Permite trazer para o TR, de forma seletiva e rastreável, os dados já elaborados no ETP do processo: seções narrativas (objeto, justificativa, especificações, valor estimado), campos do cabeçalho (valor estimado, pesquisa de preços vinculada) e quantidades dos itens. A importação acontece em dois passos — uma prévia somente leitura e uma aplicação idempotente — para que o redator revise antes de confirmar e nunca perca dados sem querer.

## Valor para o usuário e para o órgão
- Elimina a redigitação de objeto, justificativa, especificações e valor estimado do ETP para o TR.
- Reduz divergência entre ETP e TR na origem, em vez de descobri-la só na licitação.
- Mantém rastreabilidade: todo TR importado registra de qual ETP e de qual versão os dados vieram.

## Personas
- Planejamento (`PLANEJAMENTO`), Compras (`COMPRAS`) — conduzem a importação ao elaborar o TR.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-037 | Importar dados do ETP para o TR | P0 | M | US-020, US-036 |

## Escopo
- Prévia seletiva (por seção, campo e item) do que seria alterado a partir do ETP vigente do processo.
- Aplicação idempotente e rastreável da seleção escolhida, com nova versão do documento.
- Indicador no editor de que o ETP mudou desde a última importação.

## Fora de escopo
- Edição manual do conteúdo importado — segue o editor de seções e condições de FT-024/FT-026 normalmente, após a importação.
- Validação de consistência remanescente entre ETP e TR (quantidade, garantia) — tratada em FT-027.

## Regras de negócio da feature
- A origem é o documento ETP não cancelado do processo; sem ETP → 422 `ETP_REQUIRED_FOR_IMPORT` (RN-TR-16).
- O mapeamento vem de `DocumentTemplateVersion.importMappings`: seções em modo `REPLACE` ou `APPEND`, campos do cabeçalho e quantidades dos itens (RN-TR-17).
- A prévia é somente leitura e emite um `importToken` válido por 15 minutos; mudanças no ETP ou no TR entre a prévia e a aplicação invalidam o token (410 `IMPORT_PREVIEW_EXPIRED`) (RN-TR-18/RN-TR-19).
- A aplicação é seletiva: só seções, campos e itens marcados são alterados (RN-TR-20); itens já especificados no TR só são sobrescritos com confirmação explícita (RN-TR-21).
- Importar o valor estimado define `estimatedValueSource = ETP`; substituir uma origem já vinculada à pesquisa de preços exige confirmação (RN-TR-22).
- Sujeita ao sigilo do orçamento: sem `PROCESS_VIEW_CONFIDENTIAL_BUDGET` nem custódia, o valor não é mostrado nem importado (RN-TR-23).

## Telas
- SCR-012 — TR (editor), painel "Importar do ETP" (`/processos/[id]/tr/[termId]`)

## Endpoints
- `TRM-05` `POST /terms/{id}/import-etp/preview` — prévia seletiva.
- `TRM-06` `POST /terms/{id}/import-etp` — aplicação da importação.
- `TRM-03` `GET /terms/{id}` — reaproveitado para o indicador `etpChangedSinceImport`.
- `ETP-03` `GET /etps/{id}` — link "ver ETP" a partir do painel.

## Entidades
- `TermOfReference` — recebe os dados importados (`importedFromEtpId`/`importedFromEtpVersionId`).
- `Etp` — origem da importação (consumida, somente leitura).
- `DocumentItem` — coleção de itens, atualizada por upsert na importação.
- `DocumentTemplateVersion.importMappings` — mapeamento consumido.

## Eventos
- `TermImportedFromEtp` — na aplicação da importação.
- `DocumentVersionCreated` (`reason = IMPORT`) — mesma transação.

## Permissões
- `TERM_UPDATE` — pré-visualizar e aplicar a importação.
- `PROCESS_VIEW_CONFIDENTIAL_BUDGET` — ver/importar o valor estimado sob sigilo (POL-09).

## Dependências
- **Stories:** US-020 (seções do ETP, fonte dos dados), US-036 (cria o TR), US-110 (mapeamento padrão semeado).
- **Decisões/ADRs:** DEC-017, DEC-018, DEC-019, DEC-030, DEC-032, DEC-056, DEC-104, DEC-105, DEC-161; ADR-006.
- **Features:** depende de FT-024; habilita FT-027.

## Critérios de aceite da feature
```gherkin
Feature: Importação do ETP
  Scenario: Pré-visualizar e aplicar a importação do ETP no TR
    Given que o processo tem um ETP finalizado e um TR em "DRAFT"
    When "Carla" solicitar a prévia de importação
    Then o sistema deve apresentar as seções, campos e itens propostos a partir do ETP
    When "Carla" aplicar a importação com a seleção padrão
    Then o TR deve ser atualizado, gerar uma nova versão e o evento "TermImportedFromEtp"
```

## Métricas de sucesso
- ≥ 80% dos TRs de processos com ETP finalizado usam a importação ao menos uma vez.
- 0 incidentes de perda de dado não confirmada na importação (itens/seções sobrescritos sem confirmação).

## Riscos
- Importação sobrescrever edição manual já feita no TR — mitigado pela prévia seletiva e pela regra de não sobrescrever itens especificados sem confirmação (RN-TR-21).
- ETP mudar depois da importação e o TR ficar desatualizado silenciosamente — mitigado pelo indicador `etpChangedSinceImport` no editor.

## Definition of Done da feature
- [ ] US-037 concluída e aceita (critérios de aceite Gherkin passando)
- [ ] Jornada E2E "prévia → seleção parcial → aplicação → indicador de defasagem" automatizada
- [ ] Documentação (este card e story-037) atualizada
