declare global {
  interface Window {
    mcpBridge: {
      initialize(): Promise<void>;
      call(method: string, params?: unknown): Promise<unknown>;
      on(method: string, handler: (params: unknown) => void): void;
    };
  }
}

export interface ToolCallResult {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

export interface ResourceReadResult {
  contents: Array<{ uri: string; text?: string; mimeType?: string }>;
}

export async function initialize(): Promise<void> {
  return window.mcpBridge.initialize();
}

export function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  return window.mcpBridge.call('tools/call', { name, arguments: args }) as Promise<ToolCallResult>;
}

export function readResource(uri: string): Promise<ResourceReadResult> {
  return window.mcpBridge.call('resources/read', { uri }) as Promise<ResourceReadResult>;
}

export function onNotification(method: string, handler: (params: unknown) => void): void {
  window.mcpBridge.on(method, handler);
}

export function getToolText(result: ToolCallResult): string {
  return result?.content?.[0]?.text ?? '';
}

export function getResourceText(result: ResourceReadResult): string {
  return result?.contents?.[0]?.text ?? '';
}
