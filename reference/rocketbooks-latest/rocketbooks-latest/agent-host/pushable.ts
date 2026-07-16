/**
 * A pushable async iterable: an async stream you can `.push()` values into over
 * time and `.end()` when done. This is how we feed an interactive, multi-turn
 * stream of user messages into a single Agent SDK `query()` session — the SDK
 * consumes this iterable and waits on it between turns.
 */
export class Pushable<T> implements AsyncIterable<T> {
  private queue: T[] = [];
  private resolvers: Array<(r: IteratorResult<T>) => void> = [];
  private ended = false;

  push(item: T): void {
    if (this.ended) return;
    const next = this.resolvers.shift();
    if (next) next({ value: item, done: false });
    else this.queue.push(item);
  }

  end(): void {
    this.ended = true;
    let r: ((r: IteratorResult<T>) => void) | undefined;
    while ((r = this.resolvers.shift())) r({ value: undefined as unknown as T, done: true });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: (): Promise<IteratorResult<T>> => {
        if (this.queue.length > 0) {
          return Promise.resolve({ value: this.queue.shift() as T, done: false });
        }
        if (this.ended) return Promise.resolve({ value: undefined as unknown as T, done: true });
        return new Promise<IteratorResult<T>>((resolve) => this.resolvers.push(resolve));
      },
    };
  }
}
