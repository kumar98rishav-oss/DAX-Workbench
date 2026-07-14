import type { Result } from './result'

/**
 * CQRS Command Bus.
 * Commands are intent objects with a `type`. Exactly one handler is registered
 * per command type. Middleware wraps every dispatch (logging, undo capture,
 * validation) — this is where the Undo/Redo stack will hook in.
 */
export interface Command<TType extends string = string, TPayload = unknown> {
  type: TType
  payload: TPayload
}

export type CommandHandler<C extends Command, R = unknown> = (
  command: C,
) => Result<R> | Promise<Result<R>>

export type CommandMiddleware = (
  command: Command,
  next: () => Promise<Result<unknown>>,
) => Promise<Result<unknown>>

export class CommandBus {
  private handlers = new Map<string, CommandHandler<Command>>()
  private middleware: CommandMiddleware[] = []

  register<C extends Command, R>(type: C['type'], handler: CommandHandler<C, R>): void {
    if (this.handlers.has(type)) {
      throw new Error(`CommandBus: handler already registered for "${type}"`)
    }
    this.handlers.set(type, handler as CommandHandler<Command>)
  }

  use(mw: CommandMiddleware): void {
    this.middleware.push(mw)
  }

  async dispatch<R = unknown>(command: Command): Promise<Result<R>> {
    const handler = this.handlers.get(command.type)
    if (!handler) {
      return { ok: false, error: `No handler for command "${command.type}"` }
    }

    const invokeHandler = () => Promise.resolve(handler(command))

    const chain = this.middleware.reduceRight<() => Promise<Result<unknown>>>(
      (next, mw) => () => mw(command, next),
      invokeHandler,
    )

    return chain() as Promise<Result<R>>
  }
}
