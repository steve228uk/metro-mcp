import type { Logger } from '../plugin.js';

export function createLogger(name: string): Logger {
  const prefix = `[metro-mcp:${name}]`;
  return {
    info: (msg, ...args) => console.error(prefix, msg, ...args),
    warn: (msg, ...args) => console.error(prefix, 'WARN:', msg, ...args),
    error: (msg, ...args) => console.error(prefix, 'ERROR:', msg, ...args),
    debug: (msg, ...args) => {
      if (process.env.DEBUG) {
        console.error(prefix, 'DEBUG:', msg, ...args);
      }
    },
  };
}
