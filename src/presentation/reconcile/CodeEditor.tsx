import { useLayoutEffect, useRef } from 'react'
import { highlightHtml } from '@/application/reconcile/highlight'
import './code-editor.css'

/**
 * A syntax-highlighted query editor.
 *
 * Deliberately NOT CodeMirror or Monaco. This app ships eight runtime
 * dependencies and hand-builds its primitives; an editor library would be the
 * largest thing in the bundle by several times over, to colour two text boxes.
 *
 * So: a <pre> painted underneath a textarea whose own text is transparent. The
 * textarea keeps every behaviour a textarea has — caret, selection, undo,
 * autocomplete, accessibility, IME, spellcheck off — and we only draw colour
 * behind it. Nothing about editing is reimplemented, which is the whole reason
 * to do it this way.
 *
 * The two layers must agree to the PIXEL, or the caret drifts away from the
 * glyphs as you type. Everything that affects glyph position is therefore set
 * once, in one CSS rule covering both (`.ce__layer`): font, size, line-height,
 * padding, border, letter-spacing, tab-size, and crucially the identical
 * wrapping mode. Scroll position is mirrored on every scroll.
 */
export function CodeEditor({
  value,
  onChange,
  dialect,
  onKeyDown,
  ariaLabel,
}: {
  value: string
  onChange: (v: string) => void
  dialect: 'sql' | 'dax'
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  ariaLabel: string
}) {
  const taRef = useRef<HTMLTextAreaElement>(null)
  const preRef = useRef<HTMLPreElement>(null)

  // Mirror scroll synchronously, before paint: doing it in a plain effect lets
  // the highlight lag a frame behind the caret during fast scrolling, which
  // reads as the colours sliding around.
  useLayoutEffect(() => {
    const ta = taRef.current
    const pre = preRef.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }, [value])

  const syncScroll = () => {
    const ta = taRef.current
    const pre = preRef.current
    if (!ta || !pre) return
    pre.scrollTop = ta.scrollTop
    pre.scrollLeft = ta.scrollLeft
  }

  return (
    <div className="ce">
      <pre
        ref={preRef}
        className="ce__layer ce__hl"
        aria-hidden="true"
        // Safe: highlightHtml escapes every token before wrapping it, and the
        // escaping is pinned by tests that try to break out of a span.
        dangerouslySetInnerHTML={{ __html: highlightHtml(value, dialect) }}
      />
      <textarea
        ref={taRef}
        className="ce__layer ce__input"
        aria-label={ariaLabel}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onScroll={syncScroll}
        onKeyDown={onKeyDown}
      />
    </div>
  )
}
