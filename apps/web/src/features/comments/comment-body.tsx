import { isSafeCommentLink } from '@contrataflow/validation';
import type { CommentBody } from '@contrataflow/validation';
import type { ReactNode } from 'react';

/*
 * `CommentBodyView` (US-071 · RN-CMT-04/06): renderiza o JSON restrito do comentário em modo
 * leitura com os MESMOS nós e marcas do schema, como elementos React — nunca HTML vindo do
 * cliente (sem `dangerouslySetInnerHTML`). Nó ou marca desconhecido vira só o texto; link fora de
 * http/https/mailto vira texto. Links abrem em nova aba com `rel="noopener noreferrer nofollow ugc"`.
 */

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

function renderNode(node: Node, key: string): ReactNode {
  const inner = () =>
    children(node).map((child, index) => renderNode(child, `${key}.${String(index)}`));
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
      const label = isRecord(node.attrs) ? node.attrs.label : undefined;
      return (
        <span key={key} className="font-medium text-primary">
          @{typeof label === 'string' ? label : ''}
        </span>
      );
    }
    case 'text':
      return renderText(node, key);
    default:
      return <span key={key}>{inner()}</span>;
  }
}

export function CommentBodyView({ body }: { readonly body: CommentBody }) {
  return (
    <div className="flex flex-col gap-2 text-sm">
      {children(body).map((node, index) => renderNode(node, String(index)))}
    </div>
  );
}
