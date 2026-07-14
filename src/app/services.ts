/**
 * APP — Composition root
 * Wires infrastructure adapters to application ports through the DI container.
 * Services resolve lazily (the parsing worker spawns on first import).
 */
import { Container, token } from '@/shared/di'
import type { FileParserPort } from '@/application/import/ports'
import { ImportService } from '@/application/import/import-service'
import { WorkerFileParser } from '@/infrastructure/parsing/worker-parser'
import type { AnalystProvider } from '@/application/insights/analyst-provider'
import { LocalAnalystProvider } from '@/application/insights/analyst-provider'

export const FileParserToken = token<FileParserPort>('FileParserPort')
export const ImportServiceToken = token<ImportService>('ImportService')
export const AnalystToken = token<AnalystProvider>('AnalystProvider')

const container = new Container()
container.register(FileParserToken, () => new WorkerFileParser())
container.register(ImportServiceToken, (c) => new ImportService(c.resolve(FileParserToken)))
container.register(AnalystToken, () => new LocalAnalystProvider())

export const services = {
  container,
  import: (): ImportService => container.resolve(ImportServiceToken),
  analyst: (): AnalystProvider => container.resolve(AnalystToken),
}
