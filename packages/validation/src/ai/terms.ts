/*
 * Termos de uso da IA (US-116 · DEC-079 · DEC-140 · LGPD): versionados no repositório junto com
 * `AI_TERMS_VERSION`. O texto informa finalidade, provedor (subprocessador), dados enviados,
 * transferência internacional, não uso para treinamento e responsabilidade humana pelo conteúdo.
 * Nova versão = nova entrada aqui + `AI_TERMS_VERSION` na plataforma (FA-02: religar exige o aceite
 * da versão vigente). A API só guarda a versão aceita (`ai.termsAcceptedVersion`), nunca o texto.
 */

export interface AiTermsSection {
  readonly title: string;
  readonly paragraphs: readonly string[];
}

export interface AiTermsDocument {
  readonly version: string;
  readonly title: string;
  readonly sections: readonly AiTermsSection[];
}

/** Versão vigente padrão (`AI_TERMS_VERSION` sem valor no ambiente). */
export const AI_TERMS_CURRENT_VERSION = '2026-10';

const TERMS_2026_10: AiTermsDocument = {
  version: '2026-10',
  title: 'Termos de uso da inteligência artificial',
  sections: [
    {
      title: 'Finalidade',
      paragraphs: [
        'A IA ajuda a redigir o Documento de Formalização da Demanda (DFD), o Estudo Técnico Preliminar (ETP), o mapa de riscos e o Termo de Referência a partir dos dados do próprio processo, dos modelos do órgão e da Lei 14.133/2021.',
        'A IA nunca aprova, encaminha, publica nem decide. O documento só avança no fluxo por ação de uma pessoa.',
      ],
    },
    {
      title: 'Provedor e dados enviados',
      paragraphs: [
        'O provedor de IA contratado pela plataforma atua como subprocessador. Para cada geração, são enviados o resumo da necessidade, as orientações informadas e os dados do processo necessários ao documento (objeto, unidades, itens, quantidades, prazos e trechos dos documentos anteriores).',
        'Dados pessoais desnecessários (CPF, e-mail, telefone e nomes de pessoas) são removidos antes do envio. Valores de orçamento sigiloso não são enviados.',
      ],
    },
    {
      title: 'Transferência internacional e treinamento',
      paragraphs: [
        'O processamento pode ocorrer fora do Brasil, conforme o contrato com o provedor e as garantias da LGPD (art. 33).',
        'Os dados enviados não são usados para treinar modelos do provedor.',
      ],
    },
    {
      title: 'Responsabilidade pelo conteúdo',
      paragraphs: [
        'O conteúdo gerado é uma proposta e fica identificado como "gerado por IA" até ser revisado. Quantidades, valores e prazos que não estiverem no processo saem marcados como [a confirmar].',
        'A pessoa que aplica, revisa e aprova o documento responde pelo seu conteúdo.',
      ],
    },
    {
      title: 'Controle do órgão',
      paragraphs: [
        'O órgão pode desligar a IA a qualquer momento e definir limites mensais de uso e diários por pessoa. Cada geração fica registrada na auditoria com quem pediu, documento, modelo, versão do prompt, tokens e custo.',
      ],
    },
  ],
};

/** Textos por versão. */
export const AI_TERMS_DOCUMENTS: Readonly<Record<string, AiTermsDocument>> = {
  [TERMS_2026_10.version]: TERMS_2026_10,
};

/** Texto da versão pedida; versão desconhecida → a vigente padrão. */
export function aiTermsDocument(version: string): AiTermsDocument {
  return AI_TERMS_DOCUMENTS[version] ?? TERMS_2026_10;
}
