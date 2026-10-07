# ADR-010 — Validação compartilhada com Zod e contrato OpenAPI gerado

| Campo | Valor |
|---|---|
| **Status** | Aceito |
| **Data** | 2026-10-06 |
| **Decisores** | Arquitetura/Tech Lead, Produto |
| **Decisões relacionadas** | DEC-040, DEC-041, DEC-054, DEC-108 |
| **Documentos** | [api.md](../mvp-01/api.md) §1–§2 · [decisions.md](../architecture/decisions.md) |

## Contexto

- O monorepo (DEC-040/DEC-041) tem `apps/web` (Next.js) e `apps/api` (NestJS) validando as mesmas formas de dados — processo, documento, aprovação — em dois runtimes diferentes. Duplicar regras de formato em dois lugares diverge com o tempo.
- A API precisa de um contrato documentado e versionado: hoje consumido só pelo BFF (DEC-053), mas a API pública chega no MVP 3 e qualquer mudança incompatível precisa ser detectada **antes do merge**, não em produção (DEC-108).
- Erros de API têm duas naturezas distintas que não podem compartilhar o mesmo formato: falha de **formato** de campo (responsabilidade do cliente, corrigível no próprio formulário) e falha de **regra de negócio** (pode depender de estado, concorrência ou autorização) — `api.md` §2 já separa os dois em `errors[]` (`VALIDATION_ERROR`) e `violations[]` (`BUSINESS_RULE_VIOLATION`).
- Validação de regra de negócio dependente de estado (ex. uma referência precisa existir, estar ativa e no escopo do usuário) não pode viver num schema sem estado — precisa de uma fronteira clara entre schema e camada de aplicação/domínio.

## Decisão

1. **Fonte única em `packages/validation`:** schemas **Zod** compartilhados entre front e back (DEC-054). Frontend usa React Hook Form com `zodResolver`; backend usa `ZodValidationPipe` no NestJS. Tipos TypeScript são inferidos (`z.infer`) — nenhuma interface de entrada duplicada manualmente.
2. **OpenAPI 3.1 é gerado, nunca escrito à mão:** `openapi:generate` lê os schemas Zod e os metadados dos *controllers* no *bootstrap* e escreve `openapi/api.v1.json` de forma determinística — duas gerações produzem os mesmos bytes (RN-FND-38).
3. **Estágio "Contrato" no CI (US-079):** regenera o OpenAPI e compara com o arquivo versionado; qualquer mudança incompatível na v1 bloqueia o merge (DEC-108, RN-FND-23); mudanças aditivas passam.
4. **Envelope de erro único via filtro global:** toda exceção é convertida para `application/problem+json` (RFC 9457) conforme `api.md` §2 — `code` estável, `correlationId` do contexto, `errors[]` (§2.1.1, taxonomia fixa: `REQUIRED`, `INVALID_FORMAT`, `REFERENCE_NOT_FOUND` etc.) para falha de schema Zod, `violations[]` (§2.1.2) para regra de negócio vinda da camada `application`/`domain` (RN-FND-31). As duas listas nunca se misturam.
5. **Mesma ferramenta também valida configuração:** `ConfigModule` é global e valida 100% das variáveis de ambiente contra um schema Zod único no *bootstrap*; variável ausente/inválida impede o processo de subir (RN-FND-30) — mesmo mecanismo, aplicado fora do HTTP.
6. **Fronteira explícita:** validação de **formato** (schema Zod, sem estado) fica em `packages/validation`; validação de **regra de negócio** (depende de estado/outras tabelas) fica em `application`/`domain`, nunca no schema (DEC-054).
7. **Versionamento do contrato:** enquanto a v1 for suportada, só mudanças aditivas são aceitas; qualquer *breaking change* exige uma nova versão principal (DEC-108).

## Alternativas consideradas

| Alternativa | Prós | Contras | Motivo da decisão |
|---|---|---|---|
| **class-validator/class-transformer** (decorators do NestJS) | Integração nativa com Nest; maduro no ecossistema | Não compartilha schema com o frontend sem expor decorators ao browser; duplicaria regra entre React Hook Form e DTOs do Nest | **Rejeitada:** quebra a fonte única exigida (DEC-054) |
| **JSON Schema escrito manualmente + Ajv** | Padrão interoperável; geração de OpenAPI "nativa" | Sem inferência de tipos TS equivalente a `z.infer` sem gerador extra; pior ergonomia para regras condicionais; menos integrado ao React Hook Form | **Rejeitada:** perde tipagem de ponta a ponta |
| **OpenAPI escrito e mantido à mão** | Controle fino da documentação pública; independe de geração | Diverge do código real (fonte dupla de verdade); exige disciplina manual em centenas de rotas; nenhuma garantia estática contra os schemas reais | **Rejeitada:** o diff de contrato do CI só é confiável se o contrato nascer do mesmo schema que valida a requisição |
| **Envelope de erro único** (sem separar `errors[]` de `violations[]`) | Mais simples | Mistura falha de formato (cliente) com falha de regra de negócio (pode depender de estado/concorrência), dificultando tratamento diferenciado no frontend | **Rejeitada:** `api.md` já trata as duas causas como distintas (422 em ambas, mas semântica diferente) |

## Consequências

**Positivas**
- Zero duplicação de regra de formato entre frontend e backend.
- Tipos TypeScript derivados automaticamente do schema (`z.infer`), reduzindo DTOs manuais.
- Contrato sempre sincronizado com o código, porque é gerado a partir dele, não escrito em paralelo.
- Quebra de contrato é pega no CI antes do merge (RN-FND-23), não em produção.
- Clientes da API recebem erros previsíveis e taxonomizados, prontos para tratamento automático no frontend.

**Negativas**
- Frontend e backend passam a depender do mesmo pacote (`packages/validation`): mudança de schema é mudança compartilhada e exige coordenação de deploy.
- Geração determinística de OpenAPI é um requisito de engenharia extra — metadados de *controller* incompletos geram contrato incorreto.
- Zod não impede, por si, que uma regra de negócio "vaze" para o schema — a fronteira depende de disciplina e revisão de código, não só de ferramenta.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Regra de negócio vazar para o schema Zod | Fronteira explícita em DEC-054; revisão de PR |
| Metadado de *controller* incompleto gera OpenAPI incorreto | Teste de geração dupla determinística (RN-FND-38) no CI |
| Falso negativo no diff de contrato (quebra não detectada) | Revisão humana obrigatória via CODEOWNERS em PRs que tocam `packages/validation` |
| `packages/validation` como ponto único de falha de build | Cobertura de teste unitário alta; CI roda em todo push |
| Mensagem/código de erro inconsistente entre schema e regra de negócio | Taxonomia fixa e testada por campo (§2.1.1) e por violação (§2.1.2) |

## Critérios de revisão
- API pública multi-cliente (MVP 3) exigir SDKs gerados automaticamente a partir do OpenAPI.
- Volume de regras de negócio empurradas para o schema crescer a ponto de a fronteira schema/domínio virar fonte recorrente de bugs.
- Necessidade de versionar schema por tenant/feature flag que o pacote único não resolva bem.
- Integração externa (ex. PNCP) exigir um formato de erro diferente de RFC 9457.

## Referências
- DEC-040, DEC-041, DEC-054, DEC-108 — [decisions.md](../architecture/decisions.md).
- [api.md](../mvp-01/api.md) §1 (convenções gerais), §2, §2.1/§2.1.1/§2.1.2 (envelope de erro).
- US-079 — `story-079-ci-pipeline.md` (RN-FND-23, estágio "Contrato").
- US-080 — `story-080-api-foundation.md` (RN-FND-29 a RN-FND-38).
