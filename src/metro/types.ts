/**
 * Target info returned by Metro's /json endpoint.
 */
export interface MetroTarget {
  id: string;
  title: string;
  description: string;
  type: string;
  devtoolsFrontendUrl?: string;
  webSocketDebuggerUrl: string;
  faviconUrl?: string;
  url?: string;
  deviceName?: string;
  reactNative?: {
    logicalDeviceId?: string;
    capabilities?: {
      nativePageReloads?: boolean;
      nativeSourceCodeFetching?: boolean;
      /** true = New Architecture / Fusebox inspector. CDP Profiler domain is not forwarded in this mode. */
      prefersFuseboxFrontend?: boolean;
    };
  };
  vm?: string;
}

/**
 * CDP message sent to the debugger.
 */
export interface CDPRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

/**
 * CDP response from the debugger.
 */
export interface CDPResponse {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

/**
 * Discovered Metro server info.
 */
export interface MetroServerInfo {
  host: string;
  port: number;
  targets: MetroTarget[];
}
