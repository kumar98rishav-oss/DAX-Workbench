/**
 * Minimal Dependency-Injection container.
 * Register factories against typed tokens; resolve lazily as singletons.
 * Keeps the composition root explicit and swappable (great for tests/plugins).
 */
export interface Token<T> {
  readonly key: symbol
  readonly _type?: T
}

export function token<T>(description: string): Token<T> {
  return { key: Symbol(description) }
}

type Factory<T> = (c: Container) => T

export class Container {
  private factories = new Map<symbol, Factory<unknown>>()
  private singletons = new Map<symbol, unknown>()

  register<T>(t: Token<T>, factory: Factory<T>): void {
    this.factories.set(t.key, factory as Factory<unknown>)
  }

  resolve<T>(t: Token<T>): T {
    if (this.singletons.has(t.key)) {
      return this.singletons.get(t.key) as T
    }
    const factory = this.factories.get(t.key)
    if (!factory) {
      throw new Error(`DI: nothing registered for token "${t.key.description}"`)
    }
    const instance = factory(this)
    this.singletons.set(t.key, instance)
    return instance as T
  }
}
