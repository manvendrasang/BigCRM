/**
 * XSS defence (RULE 34, RULE 183).
 *
 * Two layers:
 *  1. `escapeHtml` for every text field rendered by the client. React already
 *     escapes by default; this exists for any server-rendered output, email
 *     bodies, CSV, and export files where no framework is in the loop.
 *  2. `sanitizeRichText` for the only place markup is intentionally allowed
 *     (notes). An allowlist — never a denylist — of tags and attributes.
 *
 * Every field that a client can influence passes through `safeText()` on the way
 * out of a repository. The legacy CRM had two stored-XSS sinks precisely because
 * enum validation was skipped on update and two render sites skipped escaping.
 */
import sanitizeHtml from 'sanitize-html';

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#x27;', '`': '&#x60;',
};
/** Escapes all five HTML-significant characters plus backtick for old-IE contexts. */
export const escapeHtml = (input: unknown): string =>
  String(input ?? '').replace(/[&<>"'`]/g, (c) => HTML_ESCAPES[c]!);

/** Alias used at repository boundaries. Aliasing keeps the intent obvious at call sites. */
export const safeText = escapeHtml;

const RICH_TEXT_OPTIONS: sanitizeHtml.IOptions = {
  allowedTags: [
    'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'code', 'pre', 'blockquote',
    'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'a', 'span', 'hr', 'table',
    'thead', 'tbody', 'tr', 'th', 'td',
  ],
  allowedAttributes: {
    a: ['href', 'title', 'target', 'rel'],
    span: ['class'],
    code: ['class'],
    th: ['colspan', 'rowspan'],
    td: ['colspan', 'rowspan'],
  },
  allowedSchemes: ['http', 'https', 'mailto', 'tel'],
  allowedSchemesByTag: { a: ['http', 'https', 'mailto', 'tel'] },
  allowProtocolRelative: false,
  // Drop anything with a style attribute, event handler, or embedded media.
  allowedClasses: { code: ['language-*', 'hljs*'] },
  disallowedTagsMode: 'discard',
  enforceHtmlBoundary: true,
  transformTags: {
    // Force external links to be safe regardless of what the author wrote.
    a: (tagName, attribs) => {
      const href = attribs.href ?? '#';
      const external = /^https?:\/\//i.test(href);
      return {
        tagName,
        attribs: external
          ? { ...attribs, target: '_blank', rel: 'noopener noreferrer nofollow ugc' }
          : attribs,
      };
    },
  },
};

/** Strips scripts, event handlers, javascript: URIs and unsupported markup. */
export const sanitizeRichText = (input: unknown): string =>
  sanitizeHtml(String(input ?? ''), RICH_TEXT_OPTIONS);

/** Plain-text-only field: strip *all* markup. */
export const stripHtml = (input: unknown): string =>
  sanitizeHtml(String(input ?? ''), { allowedTags: [], allowedAttributes: {} });

/** Removes control characters that can corrupt logs, headers and CSV (RULE 12). */
export const stripControlChars = (input: unknown): string =>
  String(input ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/\r\n/g, '\n');

/** Canonical single-line form for tags, company domains and search keys. */
export const normaliseTagName = (input: unknown): string =>
  stripControlChars(input).replace(/\s+/g, ' ').trim().slice(0, 60).toLowerCase();
