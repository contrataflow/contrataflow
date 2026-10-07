---
id: FT-038
title: "Tipos de documento"
epic: EP-011
mvp: 1
priority: P1
stories: [US-061]
status: Especificada
---

# FT-038 — Tipos de documento

## Título
Tipos de documento

## Épico
EP-011 — Documentos

## Descrição
Permite que o tenant administre o catálogo de tipos de documento usados nos processos: os tipos de sistema semeados pela plataforma (DFD, ETP, TR, mapa de riscos, pesquisa de preços, despacho, ofício, nota técnica, autorização, declaração, documento externo) e tipos personalizados (`FREE_TEXT`/`UPLOADED`) próprios do órgão. Cada tipo define numeração, confidencialidade padrão e, quando aplicável, política de aprovação avulsa — sem depender de desenvolvimento.

## Valor para o usuário e para o órgão
- Administrador adapta o catálogo documental ao regulamento interno (pareceres, portarias, certidões) sem abrir chamado técnico.
- Numeração e aprovação ficam centralizadas e consistentes entre todos os documentos do tenant.

## Personas
- Administrador do órgão (`ADMIN`) — cria e edita tipos personalizados; ajusta campos seguros dos tipos semeados.

## Stories
| Story | Título | Prioridade | Estimativa | Depende de |
|---|---|---|---|---|
| US-061 | Gerenciar tipos de documento | P1 | M | US-100 |

## Escopo
- Criar/editar `DocumentType` com `kind` `FREE_TEXT`/`UPLOADED` (tenant nunca cria `STRUCTURED`).
- Ajustar, em tipos de sistema, apenas os campos seguros (nome, numeração, aprovação, confidencialidade padrão, ordenação, ativo).
- Numeração por tipo (máscara e sequência), política de aprovação avulsa (`requiresApproval`/`approvalPolicy`).
- Desativação com verificação de uso em regras `REQUIRED_DOCUMENT` `BLOCKING` de workflow publicado.

## Fora de escopo
- Exclusão física de tipos (não existe rota; o ciclo é criar → editar → desativar/reativar).
- Template do tipo (criação/publicação de `DocumentTemplate`) — EP-018.
- Campos e regras dos módulos `STRUCTURED` (DFD, ETP, TR, mapa de riscos, pesquisa de preços) — outros épicos.

## Regras de negócio da feature
- **RN-DOC-01/02** — Tenant só cria `kind` `FREE_TEXT`/`UPLOADED`; `code` é único e imutável.
- **RN-DOC-03** — Tipos de sistema só permitem alterar um subconjunto seguro de campos.
- **RN-DOC-05** — Numeração por `(tenant, tipo, ano)`, máscara com `{seq:N}`/`{year}` (DEC-028).
- **RN-DOC-09** — Desativação bloqueada quando o tipo é exigido por regra `BLOCKING` de workflow `PUBLISHED`.
- **RN-DOC-12** — Listagem (`DTY-01`) é capacidade implícita, cacheada por tenant (TTL 10 min, invalidada por `DocumentTypeChanged`).

## Telas
- SCR-108 — Tipos de documento (`/admin/tipos-documento`)

## Endpoints
- DTY-01 `GET /document-types` — lista tipos (ativos por padrão)
- DTY-02 `POST /document-types` — cria tipo personalizado
- DTY-03 `PATCH /document-types/{id}` — edita campos permitidos
- DTY-04 `PUT /document-types/{id}/default-template` — define modelo padrão (US-108, fora deste épico)

## Entidades
- `DocumentType` — dono desta feature.

## Eventos
- `DocumentTypeChanged` — ao criar ou editar um tipo.

## Permissões
- `DOCUMENT_TYPE_MANAGE` — gerenciar tipos de documento.

## Dependências
- **Stories:** US-100 (contexto de tenant). Relacionadas: US-099 (semeadura dos tipos de sistema), US-105 (máscaras e sequência), US-108 (template padrão — `DTY-04`).
- **Decisões:** DEC-017, DEC-018, DEC-028, DEC-030.

## Critérios de aceite da feature
```gherkin
Feature: Tipos de documento
  Scenario: Administrador cria um tipo personalizado e passa a usá-lo
    Given que o administrador do órgão acessa "Tipos de documento"
    When ele criar o tipo "Memorando Interno" com kind "FREE_TEXT" e numeração habilitada
    Then o tipo deve aparecer ativo na lista de tipos
    And deve estar disponível no menu "Criar documento" do painel do processo (FT-039)
```

## Métricas de sucesso
- Tempo para criar um tipo personalizado < 2 min.
- 0 tipos com `code` duplicado no tenant (garantido por índice único).

## Riscos
- Desativar um tipo ainda exigido pelo workflow publicado — mitigado pela verificação de uso (RN-DOC-09) antes de permitir a desativação.

## Definition of Done da feature
- [ ] Todas as stories P0/P1 concluídas e aceitas
- [ ] Jornada E2E da feature automatizada
- [ ] Documentação atualizada
