/**
 * Typed, synchronous Event Bus.
 * Domain + application layers publish events; presentation and infrastructure
 * subscribe. Keeps modules decoupled (Observer pattern).
 */
export type EventHandler<T> = (payload: T) => void

export class EventBus<Events extends Record<string, unknown>> {
  private handlers = new Map<keyof Events, Set<EventHandler<unknown>>>()

  on<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): () => void {
    let set = this.handlers.get(type)
    if (!set) {
      set = new Set()
      this.handlers.set(type, set)
    }
    set.add(handler as EventHandler<unknown>)
    return () => this.off(type, handler)
  }

  off<K extends keyof Events>(type: K, handler: EventHandler<Events[K]>): void {
    this.handlers.get(type)?.delete(handler as EventHandler<unknown>)
  }

  emit<K extends keyof Events>(type: K, payload: Events[K]): void {
    this.handlers.get(type)?.forEach((h) => h(payload))
  }

  clear(): void {
    this.handlers.clear()
  }
}
