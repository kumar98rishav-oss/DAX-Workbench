/**
 * INFRASTRUCTURE — Worker-backed FileParser
 * Main-thread adapter that fulfils the FileParserPort by delegating to the
 * parsing Web Worker via a small promise-based RPC.
 */
import type { FileParserPort } from '@/application/import/ports'
import type { ParseInput, ParsedDataset } from '@/application/import/types'

interface WorkerResponse {
  id: number
  ok: boolean
  result?: ParsedDataset[]
  error?: string
}

interface Pending {
  resolve: (d: ParsedDataset[]) => void
  reject: (e: Error) => void
}

export class WorkerFileParser implements FileParserPort {
  private worker: Worker
  private seq = 0
  private pending = new Map<number, Pending>()

  constructor() {
    this.worker = new Worker(new URL('./parse.worker.ts', import.meta.url), {
      type: 'module',
      name: 'pbs-parser',
    })
    this.worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const { id, ok, result, error } = e.data
      const p = this.pending.get(id)
      if (!p) return
      this.pending.delete(id)
      if (ok && result) p.resolve(result)
      else p.reject(new Error(error ?? 'Failed to parse file.'))
    }
    this.worker.onerror = (e) => {
      const err = new Error(e.message || 'Worker crashed while parsing.')
      this.pending.forEach((p) => p.reject(err))
      this.pending.clear()
    }
  }

  parse(input: ParseInput): Promise<ParsedDataset[]> {
    const id = ++this.seq
    return new Promise<ParsedDataset[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      // Transfer the buffer to avoid copying large files across the boundary.
      this.worker.postMessage({ id, ...input }, [input.buffer])
    })
  }
}
