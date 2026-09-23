/**
 * PRESENTATION — DAX Autocomplete Textarea
 *
 * A drop-in replacement for the bare <textarea> in DaxView. It renders the same
 * textarea plus an absolutely-positioned autocomplete popup that mirrors how
 * Power BI Desktop's formula bar works:
 *
 *   - Type function names → DAX function suggestions with syntax
 *   - Type '            → table name suggestions
 *   - Type Table[       → column dropdown for that table
 *   - Type [            → measure suggestions
 *
 * Keyboard: ↑/↓ to navigate, Enter/Tab to accept, Escape to dismiss.
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import type { SemanticModel } from '@/domain/model'
import { getCompletions, type DaxCompletion, type CompletionKind } from '@/application/dax/dax-autocomplete'

// ---------------------------------------------------------------------------
// Kind icons — single-character badges like Power BI uses
// ---------------------------------------------------------------------------

const KIND_ICON: Record<CompletionKind, string> = {
  function: 'ƒ',
  table: 'T',
  column: '■',
  measure: 'Σ',
}

const KIND_CLASS: Record<CompletionKind, string> = {
  function: 'dax-ac__icon--fn',
  table: 'dax-ac__icon--tbl',
  column: 'dax-ac__icon--col',
  measure: 'dax-ac__icon--msr',
}

// ---------------------------------------------------------------------------
// Caret position helper
// ---------------------------------------------------------------------------

/**
 * Calculate the pixel (x, y) of the caret inside a <textarea> by mirroring
 * its content into a hidden <div> with identical styling and measuring the
 * position of a marker <span>.
 */
function getCaretCoords(
  textarea: HTMLTextAreaElement,
  position: number,
): { top: number; left: number } {
  const div = document.createElement('div')
  const style = getComputedStyle(textarea)
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle',
    'letterSpacing', 'lineHeight', 'textTransform', 'wordSpacing',
    'textIndent', 'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'boxSizing', 'whiteSpace', 'wordWrap', 'overflowWrap',
  ] as const

  div.style.position = 'absolute'
  div.style.visibility = 'hidden'
  div.style.whiteSpace = 'pre-wrap'
  div.style.wordWrap = 'break-word'
  div.style.overflow = 'hidden'
  div.style.width = `${textarea.offsetWidth}px`

  for (const p of props) {
    ;(div.style as unknown as Record<string, string>)[p] = style.getPropertyValue(
      p.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`),
    )
  }

  const textBefore = textarea.value.slice(0, position)
  const textNode = document.createTextNode(textBefore)
  const marker = document.createElement('span')
  marker.textContent = '\u200b' // zero-width space

  div.appendChild(textNode)
  div.appendChild(marker)
  document.body.appendChild(div)

  const top = marker.offsetTop - textarea.scrollTop
  const left = marker.offsetLeft - textarea.scrollLeft

  document.body.removeChild(div)

  return { top, left }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

interface Props {
  value: string
  onChange: (value: string) => void
  model: SemanticModel
  className?: string
  textareaRef?: React.RefObject<HTMLTextAreaElement>
  /** Extra onKeyDown from the parent (e.g. format shortcut). */
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
}

export function DaxAutocomplete({ value, onChange, model, className, textareaRef, onKeyDown }: Props) {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const innerRef = useRef<HTMLTextAreaElement>(null)
  const ta = textareaRef ?? innerRef
  const popupRef = useRef<HTMLDivElement>(null)

  const [items, setItems] = useState<DaxCompletion[]>([])
  const [selectedIdx, setSelectedIdx] = useState(0)
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null)
  const [sigHelp, setSigHelp] = useState<any>(null)

  const isOpen = items.length > 0
  const isSigOpen = sigHelp !== null

  // -----------------------------------------------------------------------
  // Recompute completions whenever the value or cursor changes
  // -----------------------------------------------------------------------
  const recompute = useCallback(() => {
    const el = ta.current
    if (!el) return
    const pos = el.selectionStart
    const result = getCompletions(el.value, pos, model)
    setSigHelp(result.signatureHelp ?? null)
    
    if (result.items.length > 0 || result.signatureHelp) {
      setItems(result.items)
      setSelectedIdx(0)
      const coords = getCaretCoords(el, pos)
      setAnchor({ top: coords.top + 22, left: coords.left })
    } else {
      setItems([])
      setAnchor(null)
    }
  }, [model, ta])

  // -----------------------------------------------------------------------
  // Accept a completion
  // -----------------------------------------------------------------------
  const accept = useCallback(
    (item: DaxCompletion) => {
      const el = ta.current
      if (!el) return
      const before = value.slice(0, item.replaceFrom)
      const after = value.slice(item.replaceTo)
      const next = before + item.insertText + after
      onChange(next)
      setItems([])

      // Move cursor to right after the inserted text
      const newPos = item.replaceFrom + item.insertText.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(newPos, newPos)
      })
    },
    [value, onChange, ta],
  )

  // -----------------------------------------------------------------------
  // Keyboard handler
  // -----------------------------------------------------------------------
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (isOpen) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedIdx((i) => (i + 1) % items.length)
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedIdx((i) => (i - 1 + items.length) % items.length)
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          accept(items[selectedIdx])
          return
        }
      }
      if (isOpen || isSigOpen) {
        if (e.key === 'Escape') {
          e.preventDefault()
          setItems([])
          setSigHelp(null)
          return
        }
      }
      // Pass through to parent handler (e.g. Shift+Alt+F for formatting)
      onKeyDown?.(e)
    },
    [isOpen, items, selectedIdx, accept, onKeyDown],
  )

  // -----------------------------------------------------------------------
  // Change handler
  // -----------------------------------------------------------------------
  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      onChange(e.target.value)
      // Recompute after React has flushed the new value
      setTimeout(() => recompute(), 0)
    },
    [onChange, recompute],
  )

  // -----------------------------------------------------------------------
  // Click outside → dismiss
  // -----------------------------------------------------------------------
  useEffect(() => {
    if (!isOpen && !isSigOpen) return
    const handler = (e: MouseEvent) => {
      if (
        popupRef.current &&
        !popupRef.current.contains(e.target as Node) &&
        ta.current &&
        !ta.current.contains(e.target as Node)
      ) {
        setItems([])
        setSigHelp(null)
      }
    }
    document.addEventListener('mousedown', handler)
    return () => document.removeEventListener('mousedown', handler)
  }, [isOpen, ta])

  // Keep selected item in view
  useEffect(() => {
    if (!popupRef.current) return
    const el = popupRef.current.children[selectedIdx] as HTMLElement | undefined
    el?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])

  return (
    <div className="dax-ac" ref={wrapperRef}>
      <textarea
        ref={ta as React.RefObject<HTMLTextAreaElement>}
        className={className}
        spellCheck={false}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onClick={() => setTimeout(recompute, 0)}
      />
      {isSigOpen && anchor && (
        <div
          className="dax-ac__sighelp"
          style={{ top: anchor.top - 70, left: Math.min(anchor.left, 400) }}
        >
          <div className="dax-ac__sighelp-name">{sigHelp.syntax}</div>
          <div className="dax-ac__sighelp-desc">{sigHelp.description}</div>
        </div>
      )}
      {isOpen && anchor && (
        <div
          ref={popupRef}
          className="dax-ac__popup"
          style={{ top: anchor.top, left: Math.min(anchor.left, 400) }}
        >
          {items.map((item, i) => (
            <button
              key={`${item.kind}-${item.label}`}
              className={`dax-ac__item${i === selectedIdx ? ' is-selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault() // prevent blur
                accept(item)
              }}
              onMouseEnter={() => setSelectedIdx(i)}
            >
              <span className={`dax-ac__icon ${KIND_CLASS[item.kind]}`}>
                {KIND_ICON[item.kind]}
              </span>
              <span className="dax-ac__label">{item.label}</span>
              <span className="dax-ac__detail">{item.detail}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
