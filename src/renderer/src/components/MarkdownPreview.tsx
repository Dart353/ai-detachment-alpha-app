/**
 * The rendered half of the viewer pane's markdown mode (lazy-loaded so
 * react-markdown and its bundled highlight.js stay out of the initial chunk).
 * GitHub-flavoured markdown (tables, task lists, strikethrough) via remark-gfm,
 * syntax highlighting via rehype-highlight (language auto-detected; an unknown
 * fence language renders as plain code rather than crashing).
 *
 * SECURITY: raw HTML is deliberately NOT enabled (no rehype-raw). Repository files
 * are untrusted, so any `<script>` / `<img onerror>` in the source stays inert text.
 * If raw HTML is ever wanted, it MUST be rehype-raw FOLLOWED BY rehype-sanitize,
 * never rehype-raw alone (that would reopen the XSS hole this guarantee closes).
 */
import type { JSX } from 'react'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import rehypeHighlight from 'rehype-highlight'
import './MarkdownPreview.css'

export interface MarkdownPreviewProps {
  /** the markdown source text */
  content: string
  /** stored-form absolute path of the markdown file, to resolve relative images */
  filePath: string
}

/** Directory of a stored-form path, tolerant of posix and win32 separators. */
function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return index >= 0 ? path.slice(0, index) : ''
}

/** True for an absolute or protocol-relative URL that should pass through untouched. */
function isAbsoluteUrl(src: string): boolean {
  return /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)
}

/**
 * Resolve a relative image `src` against the markdown file's directory, collapsing
 * `.`/`..` segments. Stored-form paths use `/` (posix in WSL mode, native otherwise),
 * but a reference written with `\` is tolerated too.
 */
function resolveRelative(dir: string, src: string): string {
  const base = dir.split(/[/\\]/).filter(Boolean)
  for (const segment of src.split(/[/\\]/)) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') base.pop()
    else base.push(segment)
  }
  const lead = dir.startsWith('/') ? '/' : ''
  return lead + base.join('/')
}

/**
 * A stored-form path → its `ada-file://` URL. Built per-segment
 * (encodeURIComponent, joined by unescaped slashes) so the main-side protocol
 * handler's whole-string decodeURIComponent is symmetric.
 */
function fileUrl(path: string): string {
  return 'ada-file://local' + path.split('/').map(encodeURIComponent).join('/')
}

/** The `src` an image in the preview actually points at: http(s) untouched, a
 *  relative reference resolved against the file's folder and served over
 *  `ada-file://`, and any other scheme (data:, mailto:) dropped. */
function imageSrc(src: string | undefined, fileDir: string): string | null {
  if (!src) return null
  if (/^https?:\/\//i.test(src)) return src
  if (isAbsoluteUrl(src)) return null
  return fileUrl(resolveRelative(fileDir, src))
}

export default function MarkdownPreview({
  content,
  filePath
}: MarkdownPreviewProps): JSX.Element {
  const fileDir = dirOf(filePath)

  return (
    <div className="ada-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true }]]}
        components={{
          img: ({ src, alt }) => {
            const resolved = imageSrc(typeof src === 'string' ? src : undefined, fileDir)
            // An image we cannot point anywhere gets a quiet placeholder rather
            // than the browser's broken-image glyph.
            if (!resolved) return <span className="ada-md-img-missing">{alt || 'image'}</span>
            return <img src={resolved} alt={alt ?? ''} />
          },
          a: ({ href, children }) => (
            <a
              href={href}
              onClick={(event) => {
                // Never navigate the pane. http(s) links open in the OS browser;
                // relative / in-workspace links are inert (there is no in-app
                // navigation model).
                event.preventDefault()
                if (typeof href === 'string' && /^https?:\/\//i.test(href)) {
                  window.api.openExternal(href)
                }
              }}
            >
              {children}
            </a>
          )
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  )
}
