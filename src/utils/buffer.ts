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

/**
 * Manages per-device circular buffers.
 * Each device gets its own buffer keyed by `${port}-${targetId}`.
 * Supports querying a single device or aggregating across all.
 */
export class DeviceBufferManager<T extends { timestamp: number }> {
  private buffers = new Map<string, CircularBuffer<T>>();
  private insertionOrder: string[] = [];
  private readonly maxDevices = 10;

  constructor(private readonly capacityPerDevice: number) {}

  /** Get or lazily create a buffer for the given device key. */
  getOrCreate(deviceKey: string): CircularBuffer<T> {
    let buffer = this.buffers.get(deviceKey);
    if (!buffer) {
      // Evict oldest device if at capacity
      while (this.buffers.size >= this.maxDevices && this.insertionOrder.length > 0) {
        const oldest = this.insertionOrder.shift()!;
        if (this.buffers.has(oldest)) {
          this.buffers.delete(oldest);
          break;
        }
      }
      buffer = new CircularBuffer<T>(this.capacityPerDevice);
      this.buffers.set(deviceKey, buffer);
      this.insertionOrder.push(deviceKey);
    }
    return buffer;
  }

  /** Get buffer for a specific device (undefined if not seen). */
  get(deviceKey: string): CircularBuffer<T> | undefined {
    return this.buffers.get(deviceKey);
  }

  /** Get all entries from a specific device. */
  getAllForDevice(deviceKey: string): T[] {
    return this.buffers.get(deviceKey)?.getAll() ?? [];
  }

  /**
   * Resolve a device query: "all" aggregates, a specific key queries that device,
   * or falls back to the active key. Returns entries from the resolved device.
   */
  resolve(device: string | undefined, activeKey: string | null): T[] {
    if (device === 'all') return this.getAll();
    return this.getAllForDevice(device || activeKey || '');
  }

  /** Aggregate entries across all devices, sorted by timestamp. */
  getAll(): T[] {
    const all: T[] = [];
    for (const buffer of this.buffers.values()) {
      all.push(...buffer.getAll());
    }
    return all.sort((a, b) => a.timestamp - b.timestamp);
  }

  /** Clear one device's buffer, or all buffers if no key given. */
  clear(deviceKey?: string): void {
    if (deviceKey) {
      this.buffers.get(deviceKey)?.clear();
    } else {
      for (const buffer of this.buffers.values()) {
        buffer.clear();
      }
    }
  }

  /** List all known device keys. */
  keys(): string[] {
    return [...this.buffers.keys()];
  }

  /** Total entry count across all devices. */
  get size(): number {
    let total = 0;
    for (const buffer of this.buffers.values()) {
      total += buffer.size;
    }
    return total;
  }
}
