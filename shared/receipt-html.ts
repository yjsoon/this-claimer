// Bound decoded receipt bodies as well as work on malformed markup. This is a
// text extractor for receipt recognition, not an HTML sanitizer for rendering.
export const MAX_RECEIPT_HTML = 1024 * 1024;

export function htmlToText(html: string): string {
  if (html.length > MAX_RECEIPT_HTML) throw new Error('Receipt HTML exceeds 1 MiB');
  const lower = html.toLowerCase();
  const text: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    const start = html.indexOf('<', cursor);
    if (start < 0) { text.push(html.slice(cursor)); break; }
    text.push(html.slice(cursor, start), ' ');
    const end = html.indexOf('>', start + 1);
    if (end < 0) break; // Do not rescan every '<' in an unterminated suffix.
    const tag = /^<\s*(style|script)(?=[\s/>])/i.exec(html.slice(start, end + 1));
    cursor = end + 1;
    if (tag) {
      const closing = lower.indexOf(`</${tag[1].toLowerCase()}`, cursor);
      if (closing < 0) break;
      const closingEnd = html.indexOf('>', closing);
      if (closingEnd < 0) break;
      cursor = closingEnd + 1;
    }
  }
  return text.join('')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}
