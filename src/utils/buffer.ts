export interface CircularBufferOptions<T> {
  maxBytes?: number;
  sizeOf?: (item: T) => number;
}

export interface DeviceBufferManagerOptions<T> {
  maxBytesPerDevice?: number;
  sizeOf?: (item: T) => number;
}

/**
 * Fixed-size circular buffer for storing log entries, network requests, etc.
 * When full, oldest entries are overwritten. When a byte budget is provided,
 * old entries are also evicted until the budget is met, keeping at least one item.
 */
export class CircularBuffer<T> {
  private items: T[];
  private itemSizes: number[];
  private head = 0;
  private count = 0;
  private totalBytes = 0;

  constructor(
    private readonly capacity: number,
    private readonly options: CircularBufferOptions<T> = {},
  ) {
    this.items = new Array(capacity);
    this.itemSizes = new Array(capacity).fill(0);
  }

  push(item: T): void {
    const index = (this.head + this.count) % this.capacity;
    const itemSize = this.options.sizeOf?.(item) ?? 0;
    if (this.count < this.capacity) {
      this.count++;
    } else {
      this.totalBytes -= this.itemSizes[this.head] ?? 0;
      this.head = (this.head + 1) % this.capacity;
    }
    this.items[index] = item;
    this.itemSizes[index] = itemSize;
    this.totalBytes += itemSize;

    this.evictOverBudget();
  }

  recalculateByteSize(): void {
    this.totalBytes = 0;
    for (let i = 0; i < this.count; i++) {
      const index = (this.head + i) % this.capacity;
      const size = this.options.sizeOf?.(this.items[index]!) ?? 0;
      this.itemSizes[index] = size;
      this.totalBytes += size;
    }
    this.evictOverBudget();
  }

  private evictOverBudget(): void {
    while (
      this.options.maxBytes !== undefined &&
      this.count > 1 &&
      this.totalBytes > this.options.maxBytes
    ) {
      this.totalBytes -= this.itemSizes[this.head] ?? 0;
      this.itemSizes[this.head] = 0;
      this.items[this.head] = undefined as T;
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
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
    this.itemSizes = new Array(this.capacity).fill(0);
    this.totalBytes = 0;
  }

  get size(): number {
    return this.count;
  }

  get maxSize(): number {
    return this.capacity;
  }

  get byteSize(): number {
    return this.totalBytes;
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

  constructor(
    private readonly capacityPerDevice: number,
    private readonly options: DeviceBufferManagerOptions<T> = {},
  ) {}

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
      buffer = new CircularBuffer<T>(this.capacityPerDevice, {
        maxBytes: this.options.maxBytesPerDevice,
        sizeOf: this.options.sizeOf,
      });
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

  /** Clear the same device selection syntax used by resolve(). */
  clearResolved(device: string | undefined, activeKey: string | null): void {
    if (device === 'all') {
      this.clear();
    } else {
      this.clear(device || activeKey || undefined);
    }
  }

  /** Recalculate byte accounting after a retained entry is mutated in place. */
  recalculateByteSize(deviceKey?: string): void {
    if (deviceKey) {
      this.buffers.get(deviceKey)?.recalculateByteSize();
    } else {
      for (const buffer of this.buffers.values()) {
        buffer.recalculateByteSize();
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
