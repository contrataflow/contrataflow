---
id: FT-008
title: "Elaboração do DFD"
epic: EP-002
mvp: 1
priority: P0
stories: [US-014, US-015]
status: Especificada
---

# FT-008 — Elaboração do DFD

## Título
Elaboração do DFD

## Épico
EP-002 — DFD — Documento de Formalização da Demanda

## Descrição
Esta feature entrega a criação guiada do DFD dentro do processo, a partir do template publicado do tipo, e a persistência contínua desse trabalho: wizard de 5 passos (Identificação, Justificativa, Planejamento, Revisão, Conclusão), itens ligados aos itens do processo, anexos, verificação de completude e pré-visualização (US-014); e o autosave genérico com retomada e tratamento de conflito que sustenta a edição do cabeçalho e das seções (US-015), mecanismo depois reaproveitado por ETP, TR e documentos livres.

## Valor para o usuário e para o órgão
- A requisitante registra a necessidade corretamente na primeira vez, sem dominar a Lei 14.133/2021 — o template e as validações guiam.
- Nenhum trabalho é perdido por queda de conexão, recarga de página ou edição simultânea.
- O órgão ganha um mecanismo de autosave único, reaproveitável por todos os documentos estruturados futuros.

## Personas
- Área requisitante (`REQUISITANTE`) — elabora e edita o DFD.
- Gestor de contratações (`GESTOR_CONTRATACOES`) — acompanha e pode editar.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-014 | Elaborar DFD em wizard a partir de template | P0 | L | US-006, US-065, US-110 |
| US-015 | Editar DFD com autosave, retomada e tratamento de conflito | P0 | M | US-014 |

## Escopo
- Criação do DFD (DFD-02) com cabeçalho tipado, seções do template e itens ligados a `ProcessItem`.
- Passos 1 a 4 do wizard; estrutura do passo 5 (as ações de conclusão pertencem a FT-009).
- Autosave de seção (DOC-05) e de cabeçalho (DFD-04), com `If-Match`/diálogo de conflito e contingência local (IndexedDB).

## Fora de escopo
- Ações "Concluir e enviar para aprovação" / "Finalizar DFD" (FT-009).
- Duplicação do DFD (FT-010).

## Regras de negócio da feature
- Um DFD ativo por processo (RN-DFD-01); versão do template imutável no documento (RN-DFD-03).
- Autosave não cria versão, apenas atualiza o rascunho (RN-DFD-24); conflito tratado por seção com `If-Match: "s<revision>"` (RN-DFD-25).
- Completude avaliada no servidor (DOC-08) pela mesma função usada no cliente (RN-DFD-19).

## Telas
- SCR-007 — DFD (wizard/editor) (`/processos/[id]/dfd/[dfdId]`)

## Endpoints
- DFD-01 `GET /processes/{id}/dfds` — listar DFDs do processo
- DFD-02 `POST /processes/{id}/dfds` — criar
- DFD-03 `GET /dfds/{id}` — detalhe
- DFD-04 `PATCH /dfds/{id}` — autosave de cabeçalho
- DOC-05 `PUT /documents/{id}/sections/{sectionKey}` — autosave de seção
- DOC-06/DOC-07, DOC-08, DOC-20/DOC-22/DOC-23 — itens, validação de completude e pré-visualização

## Entidades
- `Dfd` — cabeçalho tipado (dono da feature)
- `Document`, `DocumentVersion`, `DocumentItem`, `DocumentTemplateVersion` — modelo documental compartilhado
- `ProcessItem` — item canônico referenciado pelos `DocumentItem`

## Eventos
- `DocumentCreated` (`DFDCreated`) — na criação do DFD
- `ProcessItemsChanged` — ao criar item do processo a partir do DFD

## Permissões
- `DFD_CREATE` — criar DFD
- `DFD_UPDATE` — editar cabeçalho, seções e itens
- `ATTACHMENT_UPLOAD` — anexar arquivos ao DFD

## Dependências
- US-006 (itens do processo), US-065 (ciclo de vida do documento), US-110 (template DFD semeado), US-067/US-068 (pré-visualização e anexos), US-105 (numeração), US-081 (concorrência otimista).

## Critérios de aceite da feature
```gherkin
Feature: Elaboração do DFD
  Scenario: Elaborar o DFD do início à revisão, com autosave e retomada
    Given que a requisitante abre o wizard do DFD de um processo sem DFD
    When ela preenche os passos 1 a 4, com autosave salvando cada alteração
    And recarrega a página no meio da edição
    Then o DFD deve retomar no último passo salvo com o conteúdo preservado
    And a validação de completude deve refletir exatamente o que falta para concluir
```

## Métricas de sucesso
- Tempo médio até o passo "Revisão" < 20 min.
- Zero perdas de rascunho relatadas por falha de autosave.

## Riscos
- Conflito de edição concorrente mal resolvido perder conteúdo — mitigado pelo diálogo de conflito e pela contingência local (DEC-182).

## Definition of Done da feature
- [ ] US-014 e US-015 concluídas e aceitas
- [ ] Jornada E2E "elaborar → retomar → revisar" automatizada
- [ ] Documentação do wizard e do mecanismo de autosave atualizada
