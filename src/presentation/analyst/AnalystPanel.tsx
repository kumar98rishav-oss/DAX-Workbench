import { useEffect, useRef, useState } from 'react'
import { Sparkles, X, ArrowUp } from 'lucide-react'
import { useApp } from '@/app/store'
import { IconButton } from '@/design-system/components'
import { STARTER_PROMPTS } from '@/application/insights/analyst'
import './analyst.css'

function renderBold(line: string) {
  return line.split(/(\*\*[^*]+\*\*)/g).map((seg, i) =>
    seg.startsWith('**') && seg.endsWith('**') ? <strong key={i}>{seg.slice(2, -2)}</strong> : <span key={i}>{seg}</span>,
  )
}

function RichText({ text }: { text: string }) {
  return (
    <>
      {text.split('\n').map((line, i) => {
        if (line.trim() === '') return <div key={i} style={{ height: 6 }} />
        const bullet = line.trimStart().startsWith('•') || /^\d+\./.test(line.trim())
        return (
          <p key={i} className={bullet ? 'analyst-bullet' : 'analyst-line'}>
            {renderBold(line)}
          </p>
        )
      })}
    </>
  )
}

export function AnalystPanel() {
  const open = useApp((s) => s.analystOpen)
  const messages = useApp((s) => s.analystMessages)
  const thinking = useApp((s) => s.analystThinking)
  const toggle = useApp((s) => s.toggleAnalyst)
  const ask = useApp((s) => s.askAnalyst)
  const requestImport = useApp((s) => s.requestImport)
  const generateDashboard = useApp((s) => s.generateDashboard)
  const [input, setInput] = useState('')
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight, behavior: 'smooth' })
  }, [messages, thinking])

  if (!open) return null

  const handleChip = (chip: string) => {
    if (chip === 'Import data') return requestImport()
    if (chip === 'Generate dashboard') return generateDashboard()
    void ask(chip)
  }

  const submit = () => {
    const q = input.trim()
    if (!q) return
    setInput('')
    void ask(q)
  }

  return (
    <div className="analyst" role="dialog" aria-label="AI Business Analyst">
      <div className="analyst__head">
        <span className="analyst__logo">
          <Sparkles size={15} />
        </span>
        <div>
          <div className="analyst__title">Analyst</div>
          <div className="analyst__sub">Grounded in your model · local</div>
        </div>
        <span className="analyst__spacer" />
        <IconButton label="Close analyst" onClick={() => toggle(false)}>
          <X size={18} />
        </IconButton>
      </div>

      <div className="analyst__body" ref={bodyRef}>
        {messages.length === 0 && (
          <div className="analyst__empty">
            <div className="analyst__empty-icon">
              <Sparkles size={24} />
            </div>
            <p style={{ fontSize: 'var(--text-md)' }}>
              Ask about your data — trends, drivers, anomalies, and what to build next.
            </p>
            <div className="analyst__starters">
              {STARTER_PROMPTS.map((p) => (
                <button key={p} className="analyst-chip" onClick={() => void ask(p)}>
                  {p}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`analyst-msg analyst-msg--${m.role}`}>
            <div className="analyst-msg__bubble">
              <RichText text={m.text} />
            </div>
            {m.chips && m.chips.length > 0 && (
              <div className="analyst-chips">
                {m.chips.map((c) => (
                  <button key={c} className="analyst-chip" onClick={() => handleChip(c)}>
                    {c}
                  </button>
                ))}
              </div>
            )}
          </div>
        ))}

        {thinking && (
          <div className="analyst__thinking">
            <span className="analyst__dot" />
            <span className="analyst__dot" />
            <span className="analyst__dot" />
          </div>
        )}
      </div>

      <div className="analyst__foot">
        <input
          className="analyst__input"
          placeholder="Ask the analyst…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && submit()}
        />
        <button className="analyst__send" onClick={submit} disabled={!input.trim()} aria-label="Send">
          <ArrowUp size={18} />
        </button>
      </div>
    </div>
  )
}
