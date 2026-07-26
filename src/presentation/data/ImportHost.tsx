import { useEffect, useRef } from 'react'
import { Loader2, X, AlertTriangle, CheckCircle2 } from 'lucide-react'
import { useApp } from '@/app/store'

const ACCEPT = '.csv,.tsv,.txt,.xlsx,.xls,.xlsm,.parquet,.pqt'

/** Owns the hidden file inputs (data / PBIP folder / PBIX) and surfaces import progress. */
export function ImportHost() {
  const registerFilePicker = useApp((s) => s.registerFilePicker)
  const registerPbipPicker = useApp((s) => s.registerPbipPicker)
  const registerPbixPicker = useApp((s) => s.registerPbixPicker)
  const registerReportPicker = useApp((s) => s.registerReportPicker)
  const registerReportFolderPicker = useApp((s) => s.registerReportFolderPicker)
  const scanReport = useApp((s) => s.scanReport)
  const stageImport = useApp((s) => s.stageImport)
  const openPbipFiles = useApp((s) => s.openPbipFiles)
  const openPbixFile = useApp((s) => s.openPbixFile)
  const importing = useApp((s) => s.importing)
  const importError = useApp((s) => s.importError)
  const importNote = useApp((s) => s.importNote)
  const dismissImportError = useApp((s) => s.dismissImportError)
  const dismissImportNote = useApp((s) => s.dismissImportNote)

  const dataRef = useRef<HTMLInputElement>(null)
  const pbipRef = useRef<HTMLInputElement>(null)
  const pbixRef = useRef<HTMLInputElement>(null)
  const reportRef = useRef<HTMLInputElement>(null)
  const reportDirRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    registerFilePicker(() => dataRef.current?.click())
    registerPbipPicker(() => pbipRef.current?.click())
    registerPbixPicker(() => pbixRef.current?.click())
    registerReportPicker(() => reportRef.current?.click())
    registerReportFolderPicker(() => reportDirRef.current?.click())
    // Folder selection is a non-standard attribute; set it imperatively.
    for (const el of [pbipRef.current, reportDirRef.current]) {
      if (!el) continue
      el.setAttribute('webkitdirectory', '')
      el.setAttribute('directory', '')
    }
  }, [registerFilePicker, registerPbipPicker, registerPbixPicker, registerReportPicker, registerReportFolderPicker])

  return (
    <>
      <input
        ref={dataRef}
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

      <input
        ref={pbipRef}
        type="file"
        multiple
        className="pbs-visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void openPbipFiles(files)
        }}
      />

      <input
        ref={pbixRef}
        type="file"
        accept=".pbix"
        className="pbs-visually-hidden"
        onChange={(e) => {
          const file = e.target.files?.[0]
          e.target.value = ''
          if (file) void openPbixFile(file)
        }}
      />

      {/* Cleanup's report scan — a single .pbix archive. */}
      <input
        ref={reportRef}
        type="file"
        accept=".pbix"
        className="pbs-visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void scanReport(files)
        }}
      />

      {/* …or a PBIP project folder, which must be picked as a directory. */}
      <input
        ref={reportDirRef}
        type="file"
        multiple
        className="pbs-visually-hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          e.target.value = ''
          if (files.length) void scanReport(files)
        }}
      />

      {importing && (
        <div className="pbs-toast" role="status">
          <Loader2 size={16} className="pbs-spin" />
          Parsing…
        </div>
      )}

      {importNote && !importing && (
        <div className="pbs-toast pbs-toast--ok" role="status">
          <CheckCircle2 size={16} />
          <span>{importNote}</span>
          <button className="pbs-toast__close" aria-label="Dismiss" onClick={dismissImportNote}>
            <X size={14} />
          </button>
        </div>
      )}

      {importError && (
        <div className="pbs-toast pbs-toast--error" role="alert">
          <AlertTriangle size={16} />
          <span>{importError}</span>
          <button className="pbs-toast__close" aria-label="Dismiss" onClick={dismissImportError}>
            <X size={14} />
          </button>
        </div>
      )}
    </>
  )
}
