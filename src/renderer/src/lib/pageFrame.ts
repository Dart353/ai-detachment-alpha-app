/**
 * Turning an HTML file into the document a viewer pane's sandboxed frame shows.
 *
 * The frame gets the page through `srcdoc`, not by loading the file, because
 * the page is rewritten while it is being read — a workbench changes with every
 * step an agent takes — and a frame that reloads jumps back to the top. With
 * `srcdoc` the viewer adds three things ahead of the page's own markup:
 *
 *   • a Content-Security-Policy: the page may draw with its own markup, styles
 *     and scripts and show the project's images and recordings, but has no
 *     network, so an agent-written page cannot send anything anywhere;
 *   • a `<base>` at the file's folder, so `.workbench/after.png` and other
 *     relative links mean what they mean on disk;
 *   • a few lines that report the scroll position to the pane, so the next
 *     version of the page opens where the reader was.
 *
 * Pure, so the tests can pin it.
 */

/** What a shown page may load. Mirrors the CSP main sends with `ada-file://` HTML. */
export const FRAME_CSP = [
  "default-src 'none'",
  'img-src ada-file: data: blob:',
  'media-src ada-file: data: blob:',
  "style-src ada-file: 'unsafe-inline'",
  "script-src 'unsafe-inline'",
  'font-src ada-file: data:',
  "form-action 'none'"
].join('; ')

/** The message the frame posts as its reader scrolls. */
export interface FrameScrollMessage {
  adaFrameScroll: number
}

export function isFrameScrollMessage(data: unknown): data is FrameScrollMessage {
  return (
    !!data &&
    typeof data === 'object' &&
    typeof (data as Record<string, unknown>)['adaFrameScroll'] === 'number'
  )
}

/**
 * A stored-form path → its `ada-file://` URL, per segment so the protocol
 * handler's whole-string decode is symmetric (the same as main's `fileUrl`).
 */
export function fileUrl(path: string): string {
  return 'ada-file://local' + path.split('/').map(encodeURIComponent).join('/')
}

/** The folder URL a file's relative links resolve against, with its trailing slash. */
export function baseUrlOf(filePath: string): string {
  const slash = filePath.lastIndexOf('/')
  return fileUrl(slash > 0 ? filePath.slice(0, slash) : '/') + (slash > 0 ? '/' : '')
}

function attrEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Restores the scroll once the page has laid out, reports it as the reader
 * scrolls, and keeps in-page `#anchor` links in the page (with a `<base>` they
 * would otherwise point at the folder).
 */
function frameScript(scrollTop: number): string {
  const y = Math.max(0, Math.round(Number.isFinite(scrollTop) ? scrollTop : 0))
  return `<script>(function(){var y=${y};addEventListener('load',function(){if(y)scrollTo(0,y)});var t;addEventListener('scroll',function(){clearTimeout(t);t=setTimeout(function(){parent.postMessage({adaFrameScroll:scrollY},'*')},120)},{passive:true});document.addEventListener('click',function(e){var a=e.target&&e.target.closest&&e.target.closest('a[href^="#"]');if(!a)return;e.preventDefault();var el=document.getElementById(decodeURIComponent(a.getAttribute('href').slice(1)));if(el)el.scrollIntoView()})})()</script>`
}

/**
 * The page with the viewer's head prepended. It goes straight after `<head>`
 * when there is one (so it precedes anything the page loads), else after the
 * doctype (so the page keeps standards mode), else at the very top.
 */
export function buildFrameDoc(html: string, filePath: string, scrollTop = 0): string {
  const head =
    `<meta http-equiv="Content-Security-Policy" content="${attrEscape(FRAME_CSP)}">` +
    `<base href="${attrEscape(baseUrlOf(filePath))}">` +
    frameScript(scrollTop)
  const headTag = /<head\b[^>]*>/i.exec(html)
  if (headTag) {
    const at = headTag.index + headTag[0].length
    return html.slice(0, at) + head + html.slice(at)
  }
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html)
  if (doctype) return doctype[0] + head + html.slice(doctype[0].length)
  return head + html
}
