import { marked } from 'marked';
import type { Token, Tokens } from 'marked';
import type { Theme } from './theme.js';
import { plain, wrap, wrapStyled } from './text.js';

function inline(tokens: Token[] | undefined, fallback: string, theme: Theme): string {
  if (!tokens) return plain(fallback);
  return tokens.map(token => {
    switch (token.type) {
      case 'strong': return theme.paint('bold', inline(token.tokens, token.text, theme));
      case 'em': return theme.paint('italic', inline(token.tokens, token.text, theme));
      case 'codespan': return theme.paint('code', plain(token.text));
      case 'link': return `${inline(token.tokens, token.text, theme)} ${theme.paint('muted', `(${plain(token.href)})`)}`;
      case 'image': return `[image: ${plain(token.text)}]`;
      case 'br': return '\n';
      default: return 'tokens' in token && token.tokens ? inline(token.tokens, token.text ?? '', theme) : plain('text' in token ? token.text : token.raw);
    }
  }).join('');
}

/** Small, predictable highlighting for code and unified diffs; unknown syntax stays legible. */
export function highlight(line: string, language: string, theme: Theme): string {
  if (language === 'diff' || language === 'patch') {
    return theme.paint(line.startsWith('+') ? 'success' : line.startsWith('-') ? 'error' : 'muted', line);
  }
  return line.split(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|\/\/.*$|#.*$|\b(?:const|let|var|function|return|async|await|import|from|export|class|if|else|for|while|def|print|True|False|None|true|false|null|undefined|\d+)\b)/g)
    .map(token => /^(?:["'`])/.test(token) ? theme.paint('success', token)
      : /^(?:\/\/|#)/.test(token) ? theme.paint('muted', token)
      : /^(?:const|let|var|function|return|async|await|import|from|export|class|if|else|for|while|def|print|True|False|None|true|false|null|undefined|\d+)$/.test(token) ? theme.paint('code', token) : token).join('');
}

export function markdown(text: string, columns: number, theme: Theme): string[] {
  const available = Math.max(1, columns);
  try {
    const render = (tokens: Token[], width: number): string[] => tokens.flatMap((token): string[] => {
      switch (token.type) {
        case 'space': return [''];
        case 'heading': return wrapStyled(theme.paint('bold', inline(token.tokens, token.text, theme)), width);
        case 'paragraph': case 'text': return wrapStyled(inline(token.tokens, token.text, theme), width);
        case 'code': {
          const language = plain(token.lang ?? '').split(/\s/)[0] ?? '';
          return [theme.paint('border', `┌ ${language || 'code'}`),
            ...token.text.split('\n').flatMap((line: string) => wrapStyled(highlight(line, language, theme), Math.max(1, width - 2)).map(line => `${theme.paint('border', '│')} ${line}`)),
            theme.paint('border', '└' + '─'.repeat(Math.max(0, Math.min(width - 1, 24))))];
        }
        case 'list': return token.items.flatMap((item: Tokens.ListItem, i: number) => {
          const prefix = item.task ? item.checked ? '[x] ' : '[ ] ' : token.ordered ? `${Number(token.start) + i}. ` : '• ';
          const lines = render(item.tokens, Math.max(1, width - prefix.length));
          return lines.map((line, index) => (index === 0 ? prefix : ' '.repeat(prefix.length)) + line);
        });
        case 'blockquote': return render(token.tokens ?? [], Math.max(1, width - 2)).map(line => `${theme.paint('border', '│')} ${line}`);
        case 'hr': return [theme.paint('border', '─'.repeat(Math.min(width, 36)))];
        case 'table': return [token.header, ...token.rows].flatMap((row, i) => wrapStyled(row.map((cell: Tokens.TableCell) => {
          const cellText = inline(cell.tokens, cell.text, theme); return i === 0 ? theme.paint('bold', cellText) : cellText;
        }).join('  │  '), width));
        default: return wrapStyled(plain(token.raw), width);
      }
    });
    // Strip model-supplied terminal controls before parsing, including inside code blocks.
    const lines = render(marked.lexer(plain(text)), available);
    while (lines.at(-1) === '') lines.pop();
    return lines;
  } catch {
    // Markdown is model-controlled input. Deep nesting can overflow marked's
    // recursive inline parser; keep the content readable instead of failing the
    // whole terminal render (and potentially leaving raw mode behind).
    return wrap(text, available);
  }
}
