# ADR-013 — Provedor e modelo de IA para a geração de documentos do planejamento

| Campo | Valor |
|---|---|
| **Status** | **Proposto — pendente de decisão do usuário (PEND-21).** A recomendação abaixo não está aceita; até a decisão, a implementação usa só a porta `AiProvider` e o `FakeAiProvider`. |
| **Data** | 2026-10-16 |
| **Decisores** | Usuário (produto), com jurídico/DPO e Tech Lead |
| **Decisões relacionadas** | DEC-037 (IA no MVP 1), DEC-079 (módulo `ai` e `AiProvider`), DEC-030 (sigilo do orçamento), DEC-058 (AWS como primeira nuvem), DEC-137 (segredos), DEC-140 (LGPD); PEND-21, PEND-22 |
| **Documentos** | [decisions.md](../architecture/decisions.md) · stories US-115 (camada) e US-116 (configuração e limites) · [risks-and-decisions.md](../mvp-01/risks-and-decisions.md) §2, §8 e §10 |

## Contexto

- A DEC-037 antecipa para o MVP 1 a geração assistida de DFD, ETP, mapa de riscos e TR. A DEC-079 isola o provedor atrás da porta `AiProvider`, que aceita Anthropic, OpenAI e Azure OpenAI. Falta escolher **qual provedor e quais modelos** vão para produção.
- Há dois perfis de uso:
  - **Rascunho completo:** texto longo e estruturado em pt-BR jurídico-administrativo, com cerca de 10 a 40 mil tokens de entrada e 3 a 8 mil de saída. Tolera até 90 s.
  - **Ajuste de seção** (reescrever, completar, resumir): cerca de 2 a 6 mil tokens de entrada e até 1,5 mil de saída. Precisa responder em até 20 s.
- O que vai ao provedor:
  - dados do processo e dos documentos do planejamento, sem dados pessoais desnecessários (RN-AI-05) e nunca valores de orçamento sigiloso (DEC-030);
  - documentos preparatórios, que podem ter acesso restrito até o ato decisório (Lei 12.527/2011, art. 7º, §3º).
- Restrições do produto:
  - dados hospedados no Brasil, `sa-east-1` ([overview.md](../mvp-01/overview.md) §7);
  - LGPD: a transferência internacional exige um dos mecanismos do art. 33, por exemplo as cláusulas-padrão contratuais da Resolução CD/ANPD nº 19/2024;
  - AWS como primeira nuvem (DEC-058).
- **Os fatos de mercado abaixo foram levantados em outubro de 2026 em documentação pública e em fontes secundárias. Disponibilidade por região e preços mudam com frequência: confirmar tudo na data da decisão.**

## Critérios

| Critério | Peso | Como medir |
|---|---|---|
| Residência de dados e LGPD | Alto | Onde ocorre a inferência e onde ficam os dados em repouso (logs, monitoramento de abuso); se há uso para treinamento; retenção; contrato (DPA e cláusulas-padrão da ANPD) |
| Qualidade em pt-BR jurídico-administrativo | Alto | Conjunto de avaliação da US-115 (`pnpm ai:eval`): 10 processos sintéticos × 4 documentos, nota de especialista em contratações. Avalia aderência ao art. 18, uso correto dos dados, ausência de invenção (medida também por `groundingReplacements`), formalidade e respeito às marcações [a confirmar] |
| Custo por documento | Médio | Tokens médios × preço de tabela (abaixo) |
| Disponibilidade e operação | Médio | SLA, cotas, latência a partir de `sa-east-1`, integração com IAM/VPC/monitoramento/faturamento da AWS |
| Portabilidade | Baixo | Mitigada pela porta `AiProvider` |

## Opções

| | **A. Anthropic Claude via Amazon Bedrock** (região de origem `sa-east-1`) | **B. Anthropic Claude via API direta** | **C. OpenAI API direta** | **D. Azure OpenAI** |
|---|---|---|---|---|
| Inferência no Brasil | **Não garantida.** Os modelos Claude atuais (família 5.x) só são oferecidos em `sa-east-1` por perfil de inferência **Global**, e a requisição pode ser processada em outra região comercial da AWS. Modelos antigos tiveram oferta *in-region* | Não. Processamento nos EUA; a opção de restringir aos EUA tem acréscimo | Não. Residência de armazenamento em EUA, Europa, Reino Unido, Canadá, Japão, Coreia do Sul, Singapura, Índia, Austrália e EAU; Brasil fora da lista | **Possível** com implantação regional em Brazil South, para os modelos oferecidos lá (a tabela pública mostra gerações anteriores, como GPT-4.1 e GPT-4o). Os GPT-5.x em Brazil South **não foram confirmados**; as implantações Global e Data Zone processam fora |
| Dados em repouso | Região de origem; registro de invocação do Bedrock desligado | Retenção curta do provedor; *Zero Data Retention* mediante acordo | *Zero Data Retention* e residência mediante aprovação | Região da implantação |
| Treinamento com os dados | Não, segundo a política do Bedrock; o fornecedor do modelo não acessa os dados | Não, pela política comercial da API | Não, pela política da API | Não, pela política da Azure |
| Contrato | Contrato e DPA da AWS já usados na infraestrutura (DEC-058) | Contrato novo com a Anthropic | Contrato novo com a OpenAI | Contrato Microsoft e uma segunda nuvem |
| Qualidade esperada (a medir) | Modelos de ponta; bons em texto longo estruturado e em seguir restrições ("não inventar") | Igual a A, com acesso antecipado a modelos novos | Modelos de ponta | Depende do modelo disponível na região escolhida; em Brazil South, possivelmente uma geração anterior |
| Custo estimado | Sonnet 5.5 (US$ 2 entrada / US$ 10 saída por milhão): ~US$ 0,10 por rascunho completo e ~US$ 0,02 por ajuste. Haiku 5.5 (US$ 0,10 / US$ 0,50): ~US$ 0,005 e ~US$ 0,001. Perfis Global no preço de tabela | Igual a A | GPT-5.5 (US$ 5 / US$ 30): ~US$ 0,28 por rascunho completo e ~US$ 0,05 por ajuste | Próximo ao da OpenAI; implantação regional com acréscimo |
| Operação | IAM do worker, VPC endpoint, CloudWatch, faturamento único; cotas por conta e região | Chave de API externa; *egress* para a internet | Chave de API externa | Assinatura Azure, rede privada e segredos em outra nuvem |

Premissas de custo: o rascunho completo consome em média 20 mil tokens de entrada e 6 mil de saída; o ajuste, 4 mil e mil. Para um processo inteiro (4 rascunhos e cerca de 20 ajustes), as estimativas são:
- **A** com Sonnet nos rascunhos e Haiku nos ajustes: ~US$ 0,42;
- **A** só com Sonnet: ~US$ 0,76;
- **C** com GPT-5.5: ~US$ 2,10.

O limite padrão de 2 milhões de tokens por órgão e por mês (PEND-22) custa no máximo ~US$ 8 com Sonnet 5.5.

## Recomendação (a decidir pelo usuário)

**Opção A — Anthropic Claude via Amazon Bedrock**, com `sa-east-1` como região de origem e perfil de inferência Global:
- **Claude Sonnet 5.5** nos rascunhos completos (`AI_MODEL_DRAFT`);
- **Claude Haiku 5.5** nos ajustes de seção (`AI_MODEL_SECTION`);
- temperatura baixa e saída estruturada.

Motivos:
1. Fica no contrato, na rede e no faturamento da AWS (DEC-058). Não cria segunda nuvem nem chave de API externa.
2. Os dados em repouso ficam no Brasil e não há uso para treinamento.
3. É o melhor custo entre os modelos de ponta.
4. A qualidade esperada é alta para texto longo em pt-BR com restrições.

A inferência pode ocorrer fora do Brasil, mas o risco é mitigado por quatro medidas:
- minimização: sem dados pessoais e sem valores sigilosos (RN-AI-05);
- registro de invocação desligado;
- cláusulas-padrão da ANPD no contrato e no inventário de dados;
- **termos de uso aceitos pelo órgão** ao ligar a IA (US-116), que informam o processamento internacional.

**Alternativa para quem exigir inferência no Brasil:** opção D com implantação regional em Brazil South, usando o melhor modelo disponível lá, configurada por ambiente (`AI_PROVIDER=azure-openai`). Escolher o provedor por órgão (tenant) fica fora do MVP 1.

**Antes de decidir:**
- rodar o conjunto de avaliação (`pnpm ai:eval`) com A, C e D;
- confirmar residência, modelos por região e preços na data;
- obter o parecer do jurídico/DPO sobre a transferência internacional e o texto dos termos.

**Por que não B:** usa os mesmos modelos de A, mas fora do contrato e da rede da AWS, com processamento nos EUA. A única vantagem é o acesso antecipado a modelos novos.

**Por que não C:** tem o maior custo, não tem residência no Brasil e fica fora da AWS.

## Consequências

- **Se a A for aceita:**
  - adaptador `BedrockAiProvider` (AWS SDK v3, Converse API) com papel IAM do worker restrito a `bedrock:InvokeModel` nos perfis escolhidos;
  - VPC endpoint do Bedrock;
  - tabela de preços versionada;
  - cotas solicitadas antes do go-live;
  - inventário de dados de [security.md](../architecture/security.md) e termos de uso atualizados.
- **Se a D for aceita:** adaptador `AzureOpenAiProvider`, assinatura e rede na Azure (endpoint privado), segredos replicados no Secrets Manager e um runbook de operação de segunda nuvem.
- **Em qualquer caso:**
  - a decisão vira DEC, e esta ADR passa a `Aceito`;
  - a US-115 recebe o adaptador real, com testes de contrato sobre respostas gravadas (sem chamadas reais no CI);
  - o `FakeAiProvider` continua em dev, test e CI.

## Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Preço ou catálogo de modelos mudar | Tabela de preços versionada (`pricingVersion`); revisão trimestral; modelos configuráveis por ambiente |
| Mudança nas regras de residência ou de transferência internacional | Monitorar a documentação do provedor e a ANPD; a porta `AiProvider` permite trocar de provedor sem mudar o domínio |
| Qualidade insuficiente em pt-BR | Conjunto de avaliação a cada nova versão de prompt; prompts versionados; troca do modelo dos rascunhos por configuração |
| Indisponibilidade ou cota do provedor | Disjuntor e retentativas (RN-AI-08); a geração é assíncrona e a falha não bloqueia o trabalho manual; aumento de cota antes do go-live |
| Questionamento jurídico do uso de IA em documento oficial | Princípio 16, revisão humana obrigatória, rastreabilidade completa (DEC-037) e termos aceitos pelo órgão |

## Critérios de revisão

- O Bedrock passar a oferecer inferência *in-region* em `sa-east-1` para modelos atuais: trocar o perfil.
- Variação de preço acima de 30% ou novo modelo com custo-benefício melhor no conjunto de avaliação.
- Regulamentação da ANPD ou orientação de órgão de controle sobre IA generativa na administração pública.
- Cliente-piloto que exija inferência no país.

## Referências

- Internas: DEC-030, DEC-037, DEC-058, DEC-079, DEC-137, DEC-140; PEND-21, PEND-22; US-115, US-116.
- Amazon Bedrock — fichas dos modelos Claude Sonnet 5.5 e Haiku 5.5 e disponibilidade por região: <https://docs.aws.amazon.com/bedrock/latest/userguide/models-region-compatibility.html>
- Anthropic — Claude no Amazon Bedrock: <https://platform.claude.com/docs/en/build-with-claude/claude-in-amazon-bedrock>
- Microsoft Foundry — disponibilidade de modelos por região: <https://learn.microsoft.com/en-us/azure/foundry/foundry-models/concepts/models-sold-directly-by-azure-region-availability>
- OpenAI — residência de dados da API: <https://help.openai.com/en/articles/10503543-data-residency-for-the-openai-api>
- Preços, em fontes secundárias, a confirmar na página oficial de cada provedor: <https://www.eesel.ai/blog/claude-haiku-5-5-pricing> · <https://morphllm.com/openai-api-pricing>
- LGPD (Lei 13.709/2018), arts. 7º, 23 e 33; Resolução CD/ANPD nº 19/2024 (transferência internacional); Lei 12.527/2011, art. 7º, §3º.
