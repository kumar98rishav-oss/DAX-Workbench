interface KbdProps {
  keys: string[]
}

/** Renders a set of keycaps, e.g. <Kbd keys={['⌘', 'K']} />. */
export function Kbd({ keys }: KbdProps) {
  return (
    <span style={{ display: 'inline-flex', gap: 3 }}>
      {keys.map((k, i) => (
        <kbd key={i} className="pbs-kbd">
          {k}
        </kbd>
      ))}
    </span>
  )
}
