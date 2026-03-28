/**
 * Fixed-size circular buffer for storing log entries, network requests, etc.
 * When full, oldest entries are overwritten.
 */
export class CircularBuffer<T> {
  private items: T[];
  private head = 0;
  private count = 0;

  constructor(private readonly capacity: number) {
    this.items = new Array(capacity);
  }

  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.head = (this.head + 1) % this.capacity;
    }
    this.items[index] = item;
  }

  getAll(): T[] {
    const result: T[] = [];
    for (let i = 0; i < this.count; i++) {
      result.push(this.items[(this.head + i) % this.capacity]!);
    }
    return result;
  }

  getLast(n: number): T[] {
    const all = this.getAll();
    return all.slice(-n);
  }

  filter(predicate: (item: T) => boolean): T[] {
    return this.getAll().filter(predicate);
  }

  clear(): void {
    this.head = 0;
    this.count = 0;
    this.items = new Array(this.capacity);
  }

  get size(): number {
    return this.count;
  }

  get maxSize(): number {
    return this.capacity;
  }
}
