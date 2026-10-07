---
id: FT-039
title: "Documentos do processo"
epic: EP-011
mvp: 1
priority: P0
stories: [US-062, US-063, US-064]
status: Especificada
---

# FT-039 — Documentos do processo

## Título
Documentos do processo

## Épico
EP-011 — Documentos

## Descrição
Entrega o painel de documentos do processo (agrupado por tipo, com o selo "Em aprovação" e o menu "Criar documento" restrito aos tipos permitidos na etapa atual), a criação de documentos livres a partir de template com edição por seções e autosave, e a inclusão de documentos externos por upload com versionamento e prévia inline.

## Valor para o usuário e para o órgão
- Qualquer pessoa com acesso ao processo entende, em um só lugar, o que já foi produzido, o que está em aprovação e o que falta.
- Redatores produzem despachos/ofícios sem perder trabalho (autosave) e anexam arquivos já prontos sem recriá-los no editor.

## Personas
- Redator do processo (`REQUISITANTE`, `PLANEJAMENTO`) — cria e edita documentos `FREE_TEXT`/`UPLOADED`.
- Qualquer perfil com `PROCESS_VIEW` — consulta o painel.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-062 | Painel de documentos do processo | P0 | M | US-065 |
| US-063 | Criar documento livre a partir de template | P1 | M | US-015, US-065 |
| US-064 | Incluir documento externo (upload) com versões | P1 | M | US-065, US-068 |

## Escopo
- Painel agrupado por `DocumentType`, com pendências e selo "Em aprovação".
- Criação `FREE_TEXT`: modelo padrão publicado, numeração, edição de seções com autosave (sem criar versão).
- Criação `UPLOADED`: documento sem conteúdo até o primeiro envio de arquivo pelo fluxo seguro; nova versão por substituição; prévia inline para PDF/PNG/JPEG.

## Fora de escopo
- Módulos `STRUCTURED` propriamente ditos (DFD, ETP, TR, mapa de riscos, pesquisa de preços) — outros épicos.
- Transições de status, validação de completude e versionamento em si (FT-040).
- Geração de PDF (FT-041) e o próprio fluxo seguro de upload (FT-042/US-068).

## Regras de negócio da feature
- **RN-DOC-13/14** — Painel agrupado por tipo; tipos singulares mostram no máximo um documento ativo.
- **RN-DOC-15/16** — Selo "Em aprovação" por `pendingApprovalId`; menu de criação restrito à etapa e à permissão.
- **RN-DOC-21..24** — Criação `FREE_TEXT` a partir do modelo publicado, com numeração própria.
- **RN-DOC-27** — Autosave de seção (`DOC-05`) nunca cria versão nem avança o status (DEC-017).
- **RN-DOC-31..34** — Criação `UPLOADED` via fluxo seguro (US-068); cada envio cria uma `DocumentVersion`.
- **RN-DOC-36** — Prévia inline reaproveita o mesmo mecanismo de URL pré-assinada de FT-042/US-069.

## Telas
- SCR-006 — Detalhe do processo, aba Documentos (`/processos/[id]`)
- SCR-105 — Documento livre/externo, editor e visualizador (`/processos/[id]/documentos/[docId]`)

## Endpoints
- DOC-01 `GET /processes/{id}/documents` — painel
- DOC-02 `POST /processes/{id}/documents` — cria `FREE_TEXT`/`UPLOADED`
- DOC-03 `GET /documents/{id}` — detalhe
- DOC-05 `PUT /documents/{id}/sections/{sectionKey}` — autosave de seção
- DOC-19 `POST /documents/{id}/upload-version` — nova versão de `UPLOADED`
- DTY-01 `GET /document-types` — tipos ativos para o menu de criação

## Entidades
- `Document` — dono (dados comuns a `FREE_TEXT`/`UPLOADED` nesta feature).
- `DocumentItem` — consumida (coleções de itens, quando aplicável fora deste épico).

## Eventos
- `DocumentCreated` — na criação de `FREE_TEXT`/`UPLOADED`.

## Permissões
- `PROCESS_VIEW` — ver o painel.
- `DOCUMENT_CREATE` / `DOCUMENT_UPDATE` — criar e editar documentos `FREE_TEXT`/`UPLOADED`.

## Dependências
- **Stories:** US-065 (status técnico, `allowedActions` e validação de completude — FT-040); US-061 (catálogo de tipos ativos); US-015 (autosave, outro épico); US-068 (fluxo seguro de upload — FT-042).
- **Decisões:** DEC-017, DEC-018, DEC-024, DEC-028, DEC-030, DEC-056.

## Critérios de aceite da feature
```gherkin
Feature: Documentos do processo
  Scenario: Redator cria um documento livre e o vê no painel
    Given que o processo "0012/2026" está na etapa que permite o tipo "Despacho"
    When o redator criar um documento "Despacho" pelo menu "Criar documento"
    Then o documento deve abrir no editor de seções com autosave ativo
    And deve aparecer no painel de documentos do processo com status "Rascunho"
```

## Métricas de sucesso
- Tempo médio para criar um documento livre e salvar a primeira seção < 1 min.
- % de documentos `UPLOADED` com ao menos uma versão enviada em até 1 dia após a criação.

## Riscos
- Dependência de US-015 (outro épico) para o mecanismo de autosave — mitigado por `DOC-05` ser um contrato estável e compartilhado.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
