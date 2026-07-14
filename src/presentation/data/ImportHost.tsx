import { useEffect, useRef } from 'react'
import { Loader2, X, AlertTriangle } from 'lucide-react'
import { useApp } from '@/app/store'

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.parquet,.pqt'

/** Owns the hidden file input and surfaces import progress/errors. */
export function ImportHost() {
  const registerFilePicker = useApp((s) => s.registerFilePicker)
  const stageImport = useApp((s) => s.stageImport)
  const importing = useApp((s) => s.importing)
  const importError = useApp((s) => s.importError)
  const dismissImportError = useApp((s) => s.dismissImportError)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    registerFilePicker(() => inputRef.current?.click())
  }, [registerFilePicker])

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        multiple
        className="pbs-visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void stageImport(files)
        }}
      />

      {importing && (
        <div className="pbs-toast" role="status">
          <Loader2 size={16} className="pbs-spin" />
          Parsing data…
        </div>
      )}

      {importError && (
        <div className="pbs-toast pbs-toast--error" role="alert">
          <AlertTriangle size={16} />
          <span>{importError}</span>
          <button
            className="pbs-toast__close"
            aria-label="Dismiss"
            onClick={dismissImportError}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}
