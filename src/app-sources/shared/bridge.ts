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
  content?: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
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

export function onToolResultNotification(handler: (text: string, params: unknown) => void): void {
  onNotification('ui/notifications/tool-result', (params) => handler(getToolText(params), params));
}

export function getToolText(result: unknown): string {
  const content = getToolResult(result)?.content;
  if (content?.[0]?.type === 'text') return content[0].text;
  return content?.find((item) => item.type === 'text')?.text ?? '';
}

export function getResourceText(result: ResourceReadResult): string {
  return result?.contents?.[0]?.text ?? '';
}

export function getToolResult(value: unknown): ToolCallResult | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as Record<string, unknown>;
  if (Array.isArray(obj.content) || obj.structuredContent !== undefined) {
    return obj as unknown as ToolCallResult;
  }
  if (obj.result && typeof obj.result === 'object') {
    return getToolResult(obj.result);
  }
  return undefined;
}

export function getStructuredContent<T = unknown>(value: unknown): T | undefined {
  return getToolResult(value)?.structuredContent as T | undefined;
}

export function getToolJson<T = unknown>(value: unknown): T | undefined {
  const result = getToolResult(value);
  if (result?.structuredContent !== undefined) return result.structuredContent as T;
  const text = result?.content?.find((item) => item.type === 'text')?.text ?? '';
  if (!text) return undefined;
  return JSON.parse(text) as T;
}
