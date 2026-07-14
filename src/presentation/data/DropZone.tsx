import { useState } from 'react'
import { UploadCloud, Sparkles } from 'lucide-react'
import { useApp } from '@/app/store'
import { Button } from '@/design-system/components'
import { makeSampleFile } from '@/infrastructure/parsing/sample-data'

export function DropZone() {
  const requestImport = useApp((s) => s.requestImport)
  const importFiles = useApp((s) => s.importFiles)
  const stageImport = useApp((s) => s.stageImport)
  const importing = useApp((s) => s.importing)
  const [drag, setDrag] = useState(false)

  return (
    <div
      className="dropzone"
      data-drag={drag ? 'true' : undefined}
      onDragOver={(e) => {
        e.preventDefault()
        setDrag(true)
      }}
      onDragLeave={() => setDrag(false)}
      onDrop={(e) => {
        e.preventDefault()
        setDrag(false)
        const files = Array.from(e.dataTransfer.files)
        if (files.length) void stageImport(files)
      }}
    >
      <div className="dropzone__icon">
        <UploadCloud size={30} />
      </div>
      <h2 className="dropzone__title">Drop data to begin</h2>
      <p className="dropzone__desc">
        Drag a <strong>CSV</strong>, <strong>Excel</strong>, or <strong>Parquet</strong> file
        here. Studio infers the schema and profiles every column automatically.
      </p>
      <div className="dropzone__actions">
        <Button
          variant="primary"
          size="lg"
          icon={<UploadCloud size={17} />}
          onClick={requestImport}
          disabled={importing}
        >
          Browse files
        </Button>
        <Button
          variant="secondary"
          size="lg"
          icon={<Sparkles size={16} />}
          onClick={() => void importFiles([makeSampleFile()])}
          disabled={importing}
        >
          Load sample dataset
        </Button>
      </div>
      <p className="dropzone__formats">CSV · TSV · XLSX · XLS · Parquet</p>
    </div>
  )
}
