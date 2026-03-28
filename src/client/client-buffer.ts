/**
 * Simple circular buffer for client-side use.
 * Shared across all client SDK modules.
 */
export class ClientBuffer<T> {
  private items: T[] = [];
  constructor(private maxSize: number) {}

  push(item: T) {
    this.items.push(item);
    if (this.items.length > this.maxSize) this.items.shift();
  }

  getAll(): T[] { return [...this.items]; }
  clear() { this.items = []; }
  get size() { return this.items.length; }
}
