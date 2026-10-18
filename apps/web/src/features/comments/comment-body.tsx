import { isSafeCommentLink } from '@contrataflow/validation';
import type { CommentBody, CommentMentionDto } from '@contrataflow/validation';
import { useTranslations } from 'next-intl';
import type { ReactNode } from 'react';

/*
 * `CommentBodyView` (US-071 · RN-CMT-04/06): renderiza o JSON restrito do comentário em modo
 * leitura com os MESMOS nós e marcas do schema, como elementos React — nunca HTML vindo do
 * cliente (sem `dangerouslySetInnerHTML`). Nó ou marca desconhecido vira só o texto; link fora de
 * http/https/mailto vira texto. Links abrem em nova aba com `rel="noopener noreferrer nofollow ugc"`.
 * Menções (US-072): só as válidas no commit (`comment.mentions`) viram `MentionPill`; as demais
 * (alvo sem visibilidade — RN-CMT-22) ficam como rótulo simples "@Nome".
 */

/** `MentionPill` (US-072): usuário ou unidade mencionados, distinguidos por ícone e rótulo oculto. */
export function MentionPill({
  kind,
  label,
}: {
  readonly kind: 'USER' | 'DEPARTMENT';
  readonly label: string;
}) {
  const t = useTranslations('comments.mentions');
  return (
    <span className="inline-flex items-center gap-0.5 rounded-control bg-primary/10 px-1 font-medium text-primary">
      <span aria-hidden="true">{kind === 'DEPARTMENT' ? '#' : '@'}</span>
      <span className="sr-only">{kind === 'DEPARTMENT' ? t('department') : t('user')}: </span>
      {label}
    </span>
  );
}

type Node = Readonly<Record<string, unknown>>;

function isRecord(value: unknown): value is Node {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const children = (node: Node): Node[] =>
  Array.isArray(node.content) ? node.content.filter(isRecord) : [];

function renderText(node: Node, key: string): ReactNode {
  if (typeof node.text !== 'string') return null;
  const marks = Array.isArray(node.marks) ? node.marks.filter(isRecord) : [];
  let content: ReactNode = node.text;
  if (marks.some((mark) => mark.type === 'italic')) content = <em>{content}</em>;
  if (marks.some((mark) => mark.type === 'bold')) content = <strong>{content}</strong>;
  const link = marks.find((mark) => mark.type === 'link');
  const href = link && isRecord(link.attrs) ? link.attrs.href : undefined;
  if (isSafeCommentLink(href)) {
    content = (
      <a
        href={href}
        target="_blank"
        rel="noopener noreferrer nofollow ugc"
        className="break-all text-primary underline"
      >
        {content}
      </a>
    );
  }
  return <span key={key}>{content}</span>;
}

type ValidMentions = ReadonlySet<string>;

function renderNode(node: Node, key: string, mentions: ValidMentions): ReactNode {
  const inner = () =>
    children(node).map((child, index) => renderNode(child, `${key}.${String(index)}`, mentions));
  switch (node.type) {
    case 'paragraph':
      return (
        <p key={key} className="break-words whitespace-pre-wrap">
          {inner()}
        </p>
      );
    case 'bulletList':
      return (
        <ul key={key} className="list-disc pl-5">
          {inner()}
        </ul>
      );
    case 'orderedList':
      return (
        <ol key={key} className="list-decimal pl-5">
          {inner()}
        </ol>
      );
    case 'listItem':
      return <li key={key}>{inner()}</li>;
    case 'hardBreak':
      return <br key={key} />;
    case 'mention': {
      const attrs = isRecord(node.attrs) ? node.attrs : {};
      const label = typeof attrs.label === 'string' ? attrs.label : '';
      const kind = attrs.kind === 'DEPARTMENT' ? 'DEPARTMENT' : 'USER';
      const valid = typeof attrs.id === 'string' && mentions.has(`${kind}:${attrs.id}`);
      return valid ? (
        <MentionPill key={key} kind={kind} label={label} />
      ) : (
        <span key={key}>@{label}</span>
      );
    }
    case 'text':
      return renderText(node, key);
    default:
      return <span key={key}>{inner()}</span>;
  }
}

export function CommentBodyView({
  body,
  mentions = [],
}: {
  readonly body: CommentBody;
  /** Menções válidas do comentário (US-072); sem elas, todo "@Nome" é texto simples. */
  readonly mentions?: readonly CommentMentionDto[];
}) {
  const valid = new Set(mentions.map((mention) => `${mention.kind}:${mention.targetId}`));
  return (
    <div className="flex flex-col gap-2 text-sm">
      {children(body).map((node, index) => renderNode(node, String(index), valid))}
    </div>
  );
}
