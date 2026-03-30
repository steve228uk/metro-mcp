import type { RawData } from 'ws';

/** Convert ws message data (Buffer | ArrayBuffer | Buffer[]) to a UTF-8 string. */
export function wsDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString();
  if (Array.isArray(data)) return Buffer.concat(data).toString();
  return Buffer.from(data).toString();
}
