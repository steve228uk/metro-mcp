/**
 * App lifecycle event tracking.
 * Tracks foreground/background, deep links, push notifications.
 */

import { ClientBuffer } from './client-buffer.js';

export interface LifecycleEvent {
  timestamp: number;
  type: 'foreground' | 'background' | 'deep_link' | 'push_notification' | 'custom';
  data?: unknown;
}

export class LifecycleTracker {
  events = new ClientBuffer<LifecycleEvent>(100);
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;

    try {
      // React Native AppState
      const { AppState, Linking } = require('react-native');

      if (AppState) {
        AppState.addEventListener('change', (nextState: string) => {
          this.events.push({
            timestamp: Date.now(),
            type: nextState === 'active' ? 'foreground' : 'background',
          });
        });
      }

      // Deep link tracking
      if (Linking) {
        Linking.addEventListener('url', (event: { url: string }) => {
          this.events.push({
            timestamp: Date.now(),
            type: 'deep_link',
            data: { url: event.url },
          });
        });

        // Get initial URL
        Linking.getInitialURL().then((url: string | null) => {
          if (url) {
            this.events.push({
              timestamp: Date.now(),
              type: 'deep_link',
              data: { url, initial: true },
            });
          }
        });
      }
    } catch {
      // react-native not available (might be in test environment)
    }

    this.events.push({
      timestamp: Date.now(),
      type: 'foreground',
      data: { initial: true },
    });
  }

  trackCustomEvent(type: string, data?: unknown): void {
    this.events.push({
      timestamp: Date.now(),
      type: 'custom',
      data: { customType: type, ...((data as Record<string, unknown>) || {}) },
    });
  }
}
