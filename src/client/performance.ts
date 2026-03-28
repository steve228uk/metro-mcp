/**
 * Performance marks and measures.
 */

export interface PerformanceMeasure {
  name: string;
  startMark: string;
  endMark: string;
  duration: number;
}

export class PerformanceTracker {
  marks = new Map<string, number>();
  measures: PerformanceMeasure[] = [];

  mark(name: string): void {
    this.marks.set(name, Date.now());
  }

  measure(name: string, startMark: string, endMark: string): number | null {
    const start = this.marks.get(startMark);
    const end = this.marks.get(endMark);
    if (start === undefined || end === undefined) return null;

    const duration = end - start;
    this.measures.push({ name, startMark, endMark, duration });

    // Keep last 100 measures
    if (this.measures.length > 100) {
      this.measures = this.measures.slice(-100);
    }

    return duration;
  }

  getMeasures(): PerformanceMeasure[] {
    return [...this.measures];
  }

  clear(): void {
    this.marks.clear();
    this.measures = [];
  }
}
