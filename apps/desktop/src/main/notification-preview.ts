import { unified } from 'unified';
import remarkParse from 'remark-parse';

const parser = unified().use(remarkParse);
interface TextNode {
  type: string;
  value?: string;
  alt?: string | null;
  children?: TextNode[];
}

function plainText(node: TextNode): string {
  if (node.type === 'image') return node.alt || '';
  if (node.type === 'html' || node.type === 'definition') return '';
  if (node.type === 'break') return ' ';
  if (typeof node.value === 'string') return node.value;
  const separator = ['root', 'blockquote', 'list', 'listItem'].includes(node.type) ? ' ' : '';
  return (node.children || []).map(plainText).join(separator);
}

/** Native banners display text, not Markdown. Parse BEFORE clipping so a
 * truncated link/emphasis delimiter cannot leak into the notification. */
export function notificationPreview(markdown: string): string {
  const text = plainText(parser.parse(markdown)).replace(/\s+/gu, ' ').trim();
  const characters = Array.from(text);
  return characters.length > 160 ? `${characters.slice(0, 159).join('')}…` : text;
}
