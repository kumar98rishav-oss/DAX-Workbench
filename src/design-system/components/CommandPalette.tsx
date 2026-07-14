import { useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Search } from 'lucide-react'
import { Kbd } from './Kbd'
import './CommandPalette.css'

export interface Command {
  id: string
  title: string
  group: string
  icon?: ReactNode
  hint?: string
  keywords?: string[]
  run: () => void
}

interface CommandPaletteProps {
  open: boolean
  commands: Command[]
  onClose: () => void
}

export function CommandPalette({ open, commands, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Reset transient state each time the palette opens.
  useEffect(() => {
    if (open) {
      setQuery('')
      setActive(0)
      // Focus after the pop-in animation begins.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [open])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) => {
      const haystack = `${c.title} ${c.group} ${(c.keywords ?? []).join(' ')}`.toLowerCase()
      return q.split(/\s+/).every((token) => haystack.includes(token))
    })
  }, [commands, query])

  // Keep the active index within bounds as the filtered set changes.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, filtered.length - 1)))
  }, [filtered.length])

  // Ensure the active row stays visible.
  useEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  // Latest values captured via refs so the single window-level key listener
  // always reads current state without re-binding on every keystroke.
  const activeRef = useRef(active)
  activeRef.current = active
  const filteredRef = useRef(filtered)
  filteredRef.current = filtered

  // Keyboard navigation is bound at the window level (not the dialog element)
  // so it works regardless of which node holds focus — essential for a
  // keyboard-first surface.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      const list = filteredRef.current
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActive((a) => (list.length ? (a + 1) % list.length : 0))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActive((a) => (list.length ? (a - 1 + list.length) % list.length : 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cmd = list[activeRef.current]
        if (cmd) {
          onClose()
          cmd.run()
        }
      } else if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const runAt = (i: number) => {
    const cmd = filtered[i]
    if (cmd) {
      onClose()
      cmd.run()
    }
  }

  // Group the filtered commands while preserving a flat index for navigation.
  const groups: { name: string; items: { cmd: Command; index: number }[] }[] = []
  filtered.forEach((cmd, index) => {
    let g = groups.find((x) => x.name === cmd.group)
    if (!g) {
      g = { name: cmd.group, items: [] }
      groups.push(g)
    }
    g.items.push({ cmd, index })
  })

  return (
    <div
      className="pbs-cmdk__scrim"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        className="pbs-cmdk"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
      >
        <div className="pbs-cmdk__search">
          <Search size={20} />
          <input
            ref={inputRef}
            className="pbs-cmdk__input"
            placeholder="Search commands, data, actions…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            spellCheck={false}
            autoComplete="off"
          />
        </div>

        <div className="pbs-cmdk__list" ref={listRef}>
          {filtered.length === 0 ? (
            <div className="pbs-cmdk__empty">No matching commands</div>
          ) : (
            groups.map((group) => (
              <div key={group.name}>
                <div className="pbs-cmdk__group-label">{group.name}</div>
                {group.items.map(({ cmd, index }) => (
                  <button
                    key={cmd.id}
                    className="pbs-cmdk__item"
                    data-active={index === active ? 'true' : undefined}
                    onMouseMove={() => setActive(index)}
                    onClick={() => runAt(index)}
                  >
                    <span className="pbs-cmdk__item-icon">{cmd.icon}</span>
                    <span className="pbs-cmdk__item-body">
                      <span className="pbs-cmdk__item-title">{cmd.title}</span>
                    </span>
                    {cmd.hint && <span className="pbs-cmdk__item-hint">{cmd.hint}</span>}
                  </button>
                ))}
              </div>
            ))
          )}
        </div>

        <div className="pbs-cmdk__footer">
          <span className="pbs-cmdk__footer-hint">
            <Kbd keys={['↑', '↓']} /> navigate
          </span>
          <span className="pbs-cmdk__footer-hint">
            <Kbd keys={['↵']} /> run
          </span>
          <span className="pbs-cmdk__footer-hint">
            <Kbd keys={['esc']} /> close
          </span>
        </div>
      </div>
    </div>
  )
}
