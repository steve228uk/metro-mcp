import { access, readFile, readdir } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

export type NativeBackend = 'auto' | 'simview' | 'idb';

export interface NativeInputConfig {
  nativeBackend?: NativeBackend;
  simviewCommand?: string;
  idbCommand?: string;
}

export interface NativeCommandRunner {
  execFile(command: string, args: string[], options?: { maxBuffer?: number; timeout?: number }): Promise<Buffer>;
  exec(command: string): Promise<string>;
}

interface SimViewDirectoryEntry {
  name: string;
  directory: boolean;
}

interface SimViewFileSystem {
  executable(path: string): Promise<boolean>;
  readDirectory(path: string): Promise<SimViewDirectoryEntry[]>;
  readFile(path: string): Promise<string>;
}

export interface NativeInputTarget {
  platform: 'ios' | 'android';
  id: string;
}

export interface NativeDispatchResult {
  backend: 'simview' | 'idb' | 'adb' | 'none';
  dispatched: boolean;
  status: 'handled' | 'unavailable' | 'unsupported' | 'failed';
  dispatch: 'not-sent' | 'submitted' | 'unknown';
  message?: string;
}

interface Provider {
  kind: 'simview' | 'idb';
  command: string;
  args: string[];
  available: boolean;
  /** Commands which were advertised by the provider's read-only help. */
  capabilities?: Set<string>;
  /** iOS button names advertised by IDB's button help. */
  buttons?: Set<string>;
  reason?: string;
}

interface SimViewSession {
  client: SimViewClientLike;
  transport: SimViewTransportLike;
  resource: SimViewResource;
  deviceId: string;
  width: number;
  height: number;
  capabilities: Record<string, unknown>;
  tools: Set<string>;
  queue: Promise<void>;
  closed: boolean;
}

interface SimViewResource {
  client: SimViewClientLike;
  transport: SimViewTransportLike;
  closePromise: Promise<void> | null;
}

interface SimViewCallResult {
  isError?: boolean;
  structuredContent?: unknown;
  content?: Array<{ type?: string; text?: string }>;
}

interface SimViewClientLike {
  connect(transport: unknown): Promise<void>;
  listTools(): Promise<{ tools: Array<{ name: string }> }>;
  callTool(params: { name: string; arguments: Record<string, unknown> }): Promise<SimViewCallResult>;
  close(): Promise<void>;
}

interface SimViewTransportLike {
  close(): Promise<void>;
}

export interface NativeInputOptions {
  projectRoot?: string;
  config?: NativeInputConfig;
  runner: NativeCommandRunner;
  registerCleanup?: (callback: () => void | Promise<void>) => void;
  logger?: { debug(message: string, ...args: unknown[]): void; warn(message: string, ...args: unknown[]): void };
  /** Internal test/runtime discovery roots for validated SimView plugins. */
  simviewPluginRoots?: string[];
  /** Injectable MCP client for deterministic provider tests. */
  simviewClientFactory?: (command: string, args: string[]) => {
    client: SimViewClientLike;
    transport: SimViewTransportLike;
  };
  /** Internal timeout override for deterministic provider tests. */
  simviewRequestTimeoutMs?: number;
  /** Internal filesystem override for deterministic provider discovery tests. */
  simviewFileSystem?: SimViewFileSystem;
}

export function normalizeLogicalPoint(
  point: { x: number; y: number },
  width: number,
  height: number,
): { x: number; y: number } {
  return {
    x: Math.max(0, Math.min(1, point.x / width)),
    y: Math.max(0, Math.min(1, point.y / height)),
  };
}

const SIMVIEW_PLUGIN_CACHE_ROOT = resolve(homedir(), '.codex/plugins/cache');
const DEFAULT_SIMVIEW_REQUEST_TIMEOUT_MS = 2000;
// IDB's `ui key` takes USB HID usage IDs. These are the usages for Return and
// Backspace/Delete in the keyboard page (the same values used by IDB text).
const IOS_HID_KEY_CODES = { ENTER: 40, DELETE: 42 } as const;

function configValue(config: NativeInputConfig | undefined): Required<NativeInputConfig> {
  return {
    nativeBackend: config?.nativeBackend ?? 'auto',
    simviewCommand: config?.simviewCommand ?? 'simview',
    idbCommand: config?.idbCommand ?? 'idb',
  };
}

function commandTokens(command: string): string[] {
  return command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) ?? [];
}

function commandParts(command: string): { command: string; args: string[] } {
  // Commands are executable paths by design. Supporting a small quoted-path
  // form keeps config useful for paths containing spaces without invoking a shell.
  const parts = commandTokens(command);
  return { command: unquoteCommandToken(parts[0] ?? command), args: parts.slice(1).map(unquoteCommandToken) };
}

function unquoteCommandToken(value: string): string {
  return value.startsWith('"') || value.startsWith("'") ? value.slice(1, -1) : value;
}

const defaultSimViewFileSystem: SimViewFileSystem = {
  executable: async (path) => {
    try {
      await access(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
  readDirectory: async (path) => (await readdir(path, { withFileTypes: true })).map((entry) => ({ name: entry.name, directory: entry.isDirectory() })),
  readFile: (path) => readFile(path, 'utf8'),
};

async function boundedFileSystemOperation<T>(operation: () => Promise<T>, deadline?: number): Promise<T> {
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error('SimView provider discovery timed out');
  const pending = operation();
  if (remaining === undefined) return pending;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('SimView provider discovery timed out')), remaining);
  });
  try {
    return await Promise.race([pending, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function executable(path: string, deadline?: number, fileSystem = defaultSimViewFileSystem): Promise<boolean> {
  try {
    return await boundedFileSystemOperation(() => fileSystem.executable(path), deadline);
  } catch {
    return false;
  }
}

async function findSimViewPluginBinaries(
  roots: string[] = [SIMVIEW_PLUGIN_CACHE_ROOT],
  deadline?: number,
  fileSystem = defaultSimViewFileSystem,
): Promise<string[]> {
  const binaries: string[] = [];
  const seen = new Set<string>();
  const visit = async (root: string, depth: number): Promise<void> => {
    if (seen.has(root) || depth < 0 || (deadline !== undefined && deadline <= Date.now())) return;
    seen.add(root);
    if (await executable(join(root, 'bin', 'simview'), deadline, fileSystem) && await validateSimViewPlugin(root, deadline, fileSystem)) {
      binaries.push(join(root, 'bin', 'simview'));
      return;
    }
    try {
      const entries = await boundedFileSystemOperation(() => fileSystem.readDirectory(root), deadline);
      for (const entry of entries.filter((item) => item.directory).sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
        if (deadline !== undefined && deadline <= Date.now()) return;
        await visit(join(root, entry.name), depth - 1);
      }
    } catch { /* An uninstalled plugin is an ordinary unavailable provider. */ }
  };
  for (const root of roots.length ? roots : [SIMVIEW_PLUGIN_CACHE_ROOT]) {
    if (deadline !== undefined && deadline <= Date.now()) break;
    await visit(root, 3);
  }
  return binaries;
}

async function validateSimViewPlugin(root: string, deadline?: number, fileSystem = defaultSimViewFileSystem): Promise<boolean> {
  try {
    const manifest = JSON.parse(await boundedFileSystemOperation(() => fileSystem.readFile(join(root, '.codex-plugin/plugin.json')), deadline)) as Record<string, unknown>;
    const mcp = JSON.parse(await boundedFileSystemOperation(() => fileSystem.readFile(join(root, '.mcp.json')), deadline)) as Record<string, unknown>;
    const server = (mcp.mcpServers as Record<string, unknown> | undefined)?.simview as Record<string, unknown> | undefined;
    const command = server?.command;
    const args = server?.args;
    const repository = typeof manifest.repository === 'string' ? manifest.repository.replace(/\.git$/, '') : '';
    return manifest.name === 'simview' && repository === 'https://github.com/toolingtools/SimView' && command === './bin/simview' && Array.isArray(args) && args.length === 1 && args[0] === 'mcp';
  } catch { return false; }
}

/**
 * Resolve providers without downloading or installing anything. Explicit
 * paths win, followed by project-local binaries, PATH, then the validated
 * bundled SimView plugin installation.
 */
export async function discoverNativeProviders(
  options: NativeInputOptions,
  deadline?: number,
): Promise<Provider[]> {
  const config = configValue(options.config);
  const result: Provider[] = [];
  const candidates = ([
    { kind: 'simview', command: config.simviewCommand, explicit: options.config?.simviewCommand !== undefined },
    { kind: 'idb', command: config.idbCommand, explicit: options.config?.idbCommand !== undefined },
  ] as Array<{ kind: 'simview' | 'idb'; command: string; explicit: boolean }>).filter(
    (candidate) => config.nativeBackend === 'auto' || candidate.kind === config.nativeBackend,
  );

  for (const candidate of candidates) {
    let parts = commandParts(candidate.command);
    const fileSystem = candidate.kind === 'simview' ? options.simviewFileSystem ?? defaultSimViewFileSystem : defaultSimViewFileSystem;
    const discoveryDeadline = candidate.kind === 'simview' ? deadline : undefined;
    if (candidate.explicit) {
      const tokens = commandTokens(candidate.command);
      for (let index = tokens.length; index > 0; index--) {
        const possiblePath = tokens.slice(0, index).map(unquoteCommandToken).join(' ');
        if (await executable(possiblePath, discoveryDeadline, fileSystem)) {
          parts = { command: possiblePath, args: tokens.slice(index).map(unquoteCommandToken) };
          break;
        }
      }
    }
    const paths = candidate.explicit
      ? [parts.command]
      : [
          ...(options.projectRoot ? [join(options.projectRoot, 'node_modules/.bin', parts.command)] : []),
          ...(options.projectRoot ? [join(options.projectRoot, parts.command)] : []),
          parts.command,
        ];
    let selected: string | undefined;
    const selectPath = async (path: string): Promise<boolean> => {
      if (candidate.explicit || (path.includes('/') ? await executable(path) : await commandExists(options.runner, path, candidate.kind === 'simview' ? deadline : undefined))) {
        selected = path;
        return true;
      }
      return false;
    };
    for (const path of paths) {
      if (await selectPath(path)) break;
    }
    if (!selected && candidate.kind === 'simview' && (deadline === undefined || deadline > Date.now())) {
      const pluginPaths = await findSimViewPluginBinaries(options.simviewPluginRoots, discoveryDeadline, fileSystem);
      for (const path of pluginPaths) {
        selected = path;
        break;
      }
    }
    if (!selected) {
      result.push({ kind: candidate.kind, command: parts.command, args: parts.args, available: false, reason: 'not installed' });
      continue;
    }
    try {
      const probed = await probeProvider(options.runner, candidate.kind, selected, parts.args, deadline);
      result.push({ kind: candidate.kind, command: selected, args: parts.args, available: true, ...probed });
    } catch (error) {
      result.push({
        kind: candidate.kind,
        command: selected,
        args: parts.args,
        available: false,
        reason: `version probe failed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }
  return result;
}

async function probeProvider(
  runner: NativeCommandRunner,
  kind: Provider['kind'],
  command: string,
  args: string[],
  deadline?: number,
): Promise<{ capabilities?: Set<string>; buttons?: Set<string> }> {
  let versionError: unknown;
  try {
    await boundedExecFile(runner, command, [...args, '--version'], { maxBuffer: 64 * 1024 }, kind === 'simview' ? deadline : undefined);
  } catch (error) {
    versionError = error;
  }
  if (kind !== 'idb') {
    if (versionError) throw versionError;
    return {};
  }

  // IDB releases in the wild do not consistently implement --version. Help
  // is therefore the source of truth, and is deliberately probed even when
  // --version succeeds. This also lets an older installation advertise a
  // partial set of input operations without making the whole provider unusable.
  let help: string;
  try {
    help = (await runner.execFile(command, [...args, '--help'], { maxBuffer: 128 * 1024 })).toString('utf8');
  } catch (error) {
    throw new Error(`IDB help probe failed${versionError ? ` after version probe: ${error instanceof Error ? error.message : String(error)}` : `: ${error instanceof Error ? error.message : String(error)}`}`);
  }
  if (!hasHelpCommand(help, 'ui')) throw new Error('IDB help does not advertise the ui command');

  let uiHelp: string;
  try {
    uiHelp = (await runner.execFile(command, [...args, 'ui', '--help'], { maxBuffer: 128 * 1024 })).toString('utf8');
  } catch (error) {
    throw new Error(`IDB ui help probe failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const capabilities = new Set<string>();
  const buttons = new Set<string>();
  if (hasHelpCommand(help, 'describe')) capabilities.add('describe');
  if (hasHelpCommand(uiHelp, 'describe-all')) capabilities.add('describe-all');
  if (hasHelpCommand(uiHelp, 'tap')) capabilities.add('tap');
  if (hasHelpCommand(uiHelp, 'text')) capabilities.add('text');
  if (hasHelpCommand(uiHelp, 'swipe')) capabilities.add('swipe');
  if (hasHelpCommand(uiHelp, 'button')) capabilities.add('button');
  if (hasHelpCommand(uiHelp, 'key')) capabilities.add('key');

  // Long press and timed swipe depend on their operation-specific option.
  // Probe these read-only help pages independently so a provider can retain
  // the capabilities it does support when one command is incomplete.
  if (capabilities.has('tap')) {
    const tapHelp = await readOperationHelp(runner, command, args, 'tap');
    if (tapHelp && /(?:^|\s)--duration(?:\s|$)/m.test(tapHelp)) capabilities.add('long_press');
  }
  if (capabilities.has('swipe')) {
    const swipeHelp = await readOperationHelp(runner, command, args, 'swipe');
    if (swipeHelp && /(?:^|\s)--duration(?:\s|$)/m.test(swipeHelp)) capabilities.add('swipe-duration');
  }
  if (capabilities.has('button')) {
    const buttonHelp = await readOperationHelp(runner, command, args, 'button');
    for (const button of ['APPLE_PAY', 'HOME', 'LOCK', 'SIDE_BUTTON', 'SIRI']) {
      if (buttonHelp && new RegExp(`(?:\\{|,|\\s)${button}(?=,|\\}|\\s|$)`, 'm').test(buttonHelp)) buttons.add(button.toLowerCase());
    }
  }
  return { capabilities, buttons };
}

function hasHelpCommand(help: string, command: string): boolean {
  return new RegExp(`(?:\\{|,|\\s)${command.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}(?=,|\\}|\\s|$)`, 'mi').test(help);
}

async function readOperationHelp(
  runner: NativeCommandRunner,
  command: string,
  args: string[],
  operation: string,
): Promise<string | null> {
  try {
    return (await runner.execFile(command, [...args, 'ui', operation, '--help'], { maxBuffer: 128 * 1024 })).toString('utf8');
  } catch {
    return null;
  }
}

async function commandExists(runner: NativeCommandRunner, command: string, deadline?: number): Promise<boolean> {
  try {
    await boundedExecFile(runner, 'which', [command], { maxBuffer: 16 * 1024 }, deadline);
    return true;
  } catch {
    return false;
  }
}

async function boundedExecFile(
  runner: NativeCommandRunner,
  command: string,
  args: string[],
  options: { maxBuffer?: number },
  deadline?: number,
): Promise<Buffer> {
  const remaining = deadline === undefined ? undefined : deadline - Date.now();
  if (remaining !== undefined && remaining <= 0) throw new Error(`Timed out running ${command}`);
  const operation = runner.execFile(command, args, { ...options, ...(remaining === undefined ? {} : { timeout: remaining }) });
  if (remaining === undefined) return operation;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out running ${command}`)), remaining);
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function result(
  backend: NativeDispatchResult['backend'],
  status: NativeDispatchResult['status'],
  dispatched = false,
  message?: string,
  dispatch: NativeDispatchResult['dispatch'] = dispatched ? 'submitted' : 'not-sent',
): NativeDispatchResult {
  return { backend, status, dispatched, dispatch, ...(message ? { message } : {}) };
}

function dispatchEvidence(inputDispatched: unknown): NativeDispatchResult['dispatch'] {
  return inputDispatched === true ? 'submitted' : inputDispatched === false ? 'not-sent' : 'unknown';
}

export class NativeInputController {
  private readonly config: Required<NativeInputConfig>;
  private session: SimViewSession | null = null;
  private pendingSession: Promise<SimViewSession> | null = null;
  private providers: Provider[] | null = null;
  private cleanupRegistered = false;
  private cleanupPromise: Promise<void> | null = null;
  private closed = false;
  private actionQueue: Promise<void> = Promise.resolve();
  /** Track resources before connecting so shutdown can abort a pending handshake. */
  private readonly resources = new Set<SimViewResource>();
  private readonly simviewRequestTimeoutMs: number;

  constructor(private readonly options: NativeInputOptions) {
    this.config = configValue(options.config);
    this.simviewRequestTimeoutMs = Math.max(1, Math.floor(options.simviewRequestTimeoutMs ?? DEFAULT_SIMVIEW_REQUEST_TIMEOUT_MS));
    this.registerCleanup();
  }

  async providersFor(target: NativeInputTarget, deadline = this.simviewDeadline()): Promise<Provider[]> {
    // Keep successful discovery cheap, but do not make an unavailable
    // provider permanent for the lifetime of the controller. A provider can
    // be installed, added to PATH, or recover from a transient probe failure
    // while the daemon is still running.
    if (!this.providers || this.providers.some((provider) => !provider.available)) {
      this.providers = await discoverNativeProviders(this.options, deadline);
    }
    return this.providers.filter((provider) =>
      this.config.nativeBackend === 'auto' || provider.kind === this.config.nativeBackend,
    ).filter((provider) => target.platform === 'ios' || provider.kind === 'simview');
  }

  async tap(target: NativeInputTarget, x: number, y: number): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform === 'android') {
      return this.adb(target, ['shell', 'input', 'tap', String(x), String(y)], 'tap');
    }
    return this.dispatchSimViewOrIdb(target, 'tap', { x, y });
  }

  /** Locate a label through IDB's supported accessibility dump and tap its center. */
  async tapLabel(target: NativeInputTarget, label: string): Promise<NativeDispatchResult> {
    if (this.closed) return result('none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform !== 'ios') return result('none', 'unsupported', false, 'Label lookup is only available through IDB on iOS');
    const deadline = this.simviewDeadline();
    const providers = await this.providersFor(target, deadline);
    const simview = providers.find((candidate) => candidate.kind === 'simview' && candidate.available);
    if (simview) {
      const semantic = await this.simviewLabel(target, label, simview, deadline);
      if (semantic.status !== 'unavailable' && semantic.status !== 'unsupported') return semantic;
    }
    const provider = providers.find((candidate) => candidate.kind === 'idb' && candidate.available);
    if (!provider) return result('none', 'unavailable', false, 'IDB is not installed for accessibility label lookup');
    if (!provider.capabilities?.has('describe-all')) return result('idb', 'unsupported', false, 'IDB does not advertise accessibility descriptions');
    try {
      const dump = await this.options.runner.execFile(provider.command, [...provider.args, 'ui', 'describe-all', '--udid', target.id, '--json'], { maxBuffer: 2 * 1024 * 1024 });
      const match = findAccessibilityPoint(dump.toString('utf8'), label);
      if (!match.point) return result('idb', 'failed', false, match.ambiguous ? `Element "${label}" is ambiguous` : `Element "${label}" was not found by IDB`);
      return this.idb(target, 'tap', match.point, provider);
    } catch (error) {
      // The accessibility dump is performed before the tap command. A failed
      // describe-all therefore cannot have dispatched input and is safe to
      // report as not-sent for callers deciding whether to retry or fall back.
      return result('idb', 'failed', false, error instanceof Error ? error.message : String(error), 'not-sent');
    }
  }

  /** Locate a label through semantic providers and long press its frame center. */
  async longPressLabel(target: NativeInputTarget, label: string, duration: number): Promise<NativeDispatchResult> {
    if (this.closed) return result('none', 'unavailable', false, 'Native input controller is closed');

    const deadline = this.simviewDeadline();
    const providers = await this.providersFor(target, deadline);
    let fallback: NativeDispatchResult | undefined;
    const simview = providers.find((candidate) => candidate.kind === 'simview' && candidate.available);
    if (simview) {
      const semantic = await this.simviewLongPressLabel(target, label, duration, simview, deadline);
      if (semantic.status !== 'unavailable' && semantic.status !== 'unsupported') return semantic;
      fallback = semantic;
    }

    // IDB's accessibility dump and UI input commands are iOS-only. SimView
    // remains available on Android because it can query that device directly.
    if (target.platform !== 'ios') return fallback ?? result('none', 'unsupported', false, 'Label lookup is only available through SimView on Android');
    const provider = providers.find((candidate) => candidate.kind === 'idb' && candidate.available);
    if (!provider) return fallback ?? result('none', 'unavailable', false, 'IDB is not installed for accessibility label lookup');
    if (!provider.capabilities?.has('describe-all')) return result('idb', 'unsupported', false, 'IDB does not advertise accessibility descriptions');
    if (!provider.capabilities.has('long_press')) return result('idb', 'unsupported', false, 'IDB does not advertise long press input');
    try {
      const dump = await this.options.runner.execFile(provider.command, [...provider.args, 'ui', 'describe-all', '--udid', target.id, '--json'], { maxBuffer: 2 * 1024 * 1024 });
      const match = findAccessibilityPoint(dump.toString('utf8'), label);
      if (!match.point) return result('idb', match.ambiguous ? 'failed' : 'unsupported', false, match.ambiguous ? `Element "${label}" is ambiguous` : `Element "${label}" was not found by IDB`);
      return this.idb(target, 'long_press', { ...match.point, durationMs: duration }, provider);
    } catch (error) {
      return result('idb', 'unavailable', false, error instanceof Error ? error.message : String(error), 'not-sent');
    }
  }

  private async simviewLabel(target: NativeInputTarget, label: string, provider: Provider, requestDeadline?: number): Promise<NativeDispatchResult> {
    if (this.closed) return result('simview', 'unavailable', false, 'Native input controller is closed');
    let inputAttempted = false;
    try {
      return await this.withActionQueue(async () => {
        const deadline = requestDeadline ?? this.simviewDeadline();
        const session = await this.getSession(target, provider, deadline);
        return this.withSessionQueue(session, async () => {
          try {
            await this.refreshSession(session, deadline);
          } catch (error) {
            await this.invalidateSession(session, deadline);
            throw error;
          }
          if (!session.tools.has('find_elements') || !session.tools.has('tap_element')) return result('simview', 'unsupported', false, 'SimView does not provide semantic label input');
          let searchResponse: SimViewCallResult;
          try {
            searchResponse = await this.simviewRequest(
              () => session.client.callTool({ name: 'find_elements', arguments: { name: label, exact: true } }),
              `find element "${label}"`,
              deadline,
            );
          } catch (error) {
            await this.invalidateSession(session, deadline);
            throw error;
          }
          if (searchResponse.isError) return result('simview', 'unavailable', false, 'SimView semantic search is unavailable');
          const found = readStructuredResult(searchResponse);
          const matches = Array.isArray(found.matches) ? found.matches : [];
          const refs = matches.map((match) => {
            if (!match || typeof match !== 'object') return undefined;
            const value = match as Record<string, unknown>;
            const element = value.element && typeof value.element === 'object' ? value.element as Record<string, unknown> : value;
            return element.ref;
          }).filter((ref): ref is string => typeof ref === 'string');
          if (refs.length === 0) return result('simview', 'unsupported', false, `Element "${label}" was not found by SimView`);
          if (refs.length !== 1) return result('simview', 'failed', false, `Element "${label}" is ambiguous`);
          if (Date.now() >= deadline) return result('simview', 'unavailable', false, 'SimView setup timed out before input dispatch', 'not-sent');
          inputAttempted = true;
          const tapResponse = await session.client.callTool({ name: 'tap_element', arguments: { ref: refs[0] } });
          const tapped = readStructuredResult(tapResponse);
          const interaction = tapped.interaction && typeof tapped.interaction === 'object'
            ? tapped.interaction as Record<string, unknown>
            : undefined;
          const accepted = typeof interaction?.accepted === 'boolean' ? interaction.accepted : tapped.accepted;
          const inputDispatched = typeof interaction?.inputDispatched === 'boolean'
            ? interaction.inputDispatched
            : tapped.inputDispatched;
          const dispatched = inputDispatched === true;
          if (tapResponse.isError) return result('simview', 'failed', dispatched, 'SimView semantic tap result is uncertain', dispatched ? 'submitted' : 'unknown');
          if (interaction?.safeToContinue === false || tapped.safeToContinue === false) {
            return result(
              'simview',
              'failed',
              dispatched,
              'SimView reported that it is unsafe to continue after the semantic tap',
              dispatchEvidence(inputDispatched),
            );
          }
          if (accepted === false) return result('simview', 'failed', dispatched, 'SimView rejected the semantic tap', dispatched ? 'submitted' : 'not-sent');
          if (accepted === true && inputDispatched === false) {
            return result(
              'simview',
              this.config.nativeBackend === 'auto' ? 'unsupported' : 'failed',
              false,
              'SimView accepted the request without dispatching input',
            );
          }
          if (accepted !== true || inputDispatched !== true) return result('simview', 'failed', dispatched, 'SimView returned no complete semantic action receipt', dispatched ? 'submitted' : 'unknown');
          return result('simview', 'handled', true);
        });
      });
    } catch (error) {
      // Connecting, refreshing, and searching happen before SimView receives
      // the semantic tap. IDB may safely take over in auto mode in those
      // cases; once the tap request was attempted, the dispatch is uncertain.
      return result(
        'simview',
        inputAttempted ? 'failed' : 'unavailable',
        false,
        error instanceof Error ? error.message : String(error),
        inputAttempted ? 'unknown' : 'not-sent',
      );
    }
  }

  private async simviewLongPressLabel(target: NativeInputTarget, label: string, duration: number, provider: Provider, requestDeadline?: number): Promise<NativeDispatchResult> {
    if (this.closed) return result('simview', 'unavailable', false, 'Native input controller is closed');
    let inputAttempted = false;
    try {
      return await this.withActionQueue(async () => {
        const deadline = requestDeadline ?? this.simviewDeadline();
        const session = await this.getSession(target, provider, deadline);
        return this.withSessionQueue(session, async () => {
          try {
            await this.refreshSession(session, deadline);
          } catch (error) {
            await this.invalidateSession(session, deadline);
            throw error;
          }
          if (!session.tools.has('find_elements') || !session.tools.has('long_press')) {
            return result('simview', 'unsupported', false, 'SimView does not provide semantic long press input');
          }
          const input = session.capabilities.input as Record<string, unknown> | undefined;
          if (input?.touch !== true) {
            return result('simview', 'unsupported', false, 'SimView does not support touch input');
          }
          let searchResponse: SimViewCallResult;
          try {
            searchResponse = await this.simviewRequest(
              () => session.client.callTool({ name: 'find_elements', arguments: { name: label, exact: true } }),
              `find element "${label}"`,
              deadline,
            );
          } catch (error) {
            await this.invalidateSession(session, deadline);
            throw error;
          }
          if (searchResponse.isError) return result('simview', 'unavailable', false, 'SimView semantic search is unavailable');
          const found = readStructuredResult(searchResponse);
          const matches = Array.isArray(found.matches) ? found.matches : [];
          if (matches.length === 0) return result('simview', 'unsupported', false, `Element "${label}" was not found by SimView`);
          if (matches.length !== 1) return result('simview', 'failed', false, `Element "${label}" is ambiguous`);
          const match = matches[0];
          const element = match && typeof match === 'object'
            ? ((match as Record<string, unknown>).element && typeof (match as Record<string, unknown>).element === 'object'
              ? (match as Record<string, unknown>).element
              : match)
            : undefined;
          const point = simViewFrameCenter(element, session.width, session.height);
          if (!point) return result('simview', 'unsupported', false, `Element "${label}" has no usable frame`);
          if (Date.now() >= deadline) return result('simview', 'unavailable', false, 'SimView setup timed out before input dispatch', 'not-sent');
          inputAttempted = true;
          const response = await session.client.callTool({ name: 'long_press', arguments: { ...point, durationMs: duration } });
          const structured = readStructuredResult(response);
          const interaction = structured.interaction && typeof structured.interaction === 'object'
            ? structured.interaction as Record<string, unknown>
            : undefined;
          const accepted = typeof interaction?.accepted === 'boolean' ? interaction.accepted : structured.accepted;
          const inputDispatched = typeof interaction?.inputDispatched === 'boolean'
            ? interaction.inputDispatched
            : typeof structured.inputDispatched === 'boolean' ? structured.inputDispatched : undefined;
          const dispatched = inputDispatched === true;
          if (response.isError) return result('simview', 'failed', dispatched, 'SimView long press result is uncertain', dispatchEvidence(inputDispatched));
          if (interaction?.safeToContinue === false || structured.safeToContinue === false) {
            return result('simview', 'failed', dispatched, 'SimView reported that it is unsafe to continue after the long press', dispatchEvidence(inputDispatched));
          }
          if (accepted === false) return result('simview', 'failed', dispatched, 'SimView rejected the long press', dispatched ? 'submitted' : 'not-sent');
          if (accepted === true && inputDispatched === false) {
            return result(
              'simview',
              this.config.nativeBackend === 'auto' ? 'unsupported' : 'failed',
              false,
              'SimView accepted the request without dispatching input',
            );
          }
          if (accepted !== true) return result('simview', 'failed', dispatched, 'SimView returned no accepted long press receipt', dispatched ? 'submitted' : 'unknown');
          // SimView's public long_press output schema is `{ accepted: true }`.
          // Newer implementations may add inputDispatched telemetry, but the
          // schema-level acceptance itself is the successful dispatch receipt.
          return result('simview', 'handled', true);
        });
      });
    } catch (error) {
      return result(
        'simview',
        inputAttempted ? 'failed' : 'unavailable',
        false,
        error instanceof Error ? error.message : String(error),
        inputAttempted ? 'unknown' : 'not-sent',
      );
    }
  }

  async typeText(target: NativeInputTarget, text: string): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform === 'android') {
      // ADB parses this argument through the device shell; encode it once here.
      return this.adb(target, ['shell', 'input', 'text', encodeAdbInputText(text)], 'type text');
    }
    return this.dispatchSimViewOrIdb(target, 'type_text', { text });
  }

  async longPress(target: NativeInputTarget, x: number, y: number, duration: number): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform === 'android') {
      return this.adb(target, ['shell', 'input', 'swipe', String(x), String(y), String(x), String(y), String(duration)], 'long press');
    }
    return this.dispatchSimViewOrIdb(target, 'long_press', { x, y, durationMs: duration });
  }

  async swipe(target: NativeInputTarget, from: { x: number; y: number }, to: { x: number; y: number }, duration: number): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform === 'android') {
      return this.adb(target, ['shell', 'input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(duration)], 'swipe');
    }
    return this.dispatchSimViewOrIdb(target, 'swipe', { from, to, durationMs: duration });
  }

  async swipeDirection(target: NativeInputTarget, direction: 'up' | 'down' | 'left' | 'right', duration: number): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    return this.withActionQueue(async () => {
      if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
      const deadline = this.simviewDeadline();
      const geometry = await this.geometry(target, deadline);
      if (!geometry) return result('none', 'unavailable', false, 'Device geometry is unavailable; refusing to guess swipe coordinates');
      const { width, height } = geometry;
      const insetX = width * 0.2;
      const insetY = height * 0.25;
      let from: { x: number; y: number };
      let to: { x: number; y: number };
      if (direction === 'left' || direction === 'right') {
        from = { x: direction === 'left' ? width * 0.8 : insetX, y: height / 2 };
        to = { x: direction === 'left' ? insetX : width * 0.8, y: height / 2 };
      } else {
        from = { x: width / 2, y: direction === 'up' ? height * 0.75 : insetY };
        to = { x: width / 2, y: direction === 'up' ? insetY : height * 0.75 };
      }
      if (target.platform === 'android') return this.adb(target, ['shell', 'input', 'swipe', String(from.x), String(from.y), String(to.x), String(to.y), String(duration)], 'swipe');
      return this.dispatchSimViewOrIdb(target, 'swipe', { from, to, durationMs: duration }, true, deadline, geometry.simviewUnavailable);
    });
  }

  private async geometry(target: NativeInputTarget, deadline = this.simviewDeadline()): Promise<({ width: number; height: number; simviewUnavailable?: boolean }) | null> {
    if (target.platform === 'android') {
      try {
        const output = (await this.options.runner.execFile('adb', ['-s', target.id, 'shell', 'wm', 'size'], { maxBuffer: 16 * 1024 })).toString('utf8');
        const matches = [...output.matchAll(/(Override|Physical) size:\s*(\d+)x(\d+)/gi)];
        const match = matches.findLast((entry) => entry[1]?.toLowerCase() === 'override') ?? matches.at(-1);
        return match ? { width: Number(match[2]), height: Number(match[3]) } : null;
      } catch { return null; }
    }
    const providers = await this.providersFor(target, deadline);
    const simview = providers.find((provider) => provider.kind === 'simview' && provider.available);
    if (simview) {
      try {
        const session = await this.getSession(target, simview, deadline);
        await this.refreshSession(session, deadline);
        return { width: session.width, height: session.height };
      } catch (error) {
        if (this.session) await this.invalidateSession(this.session, deadline);
        /* Try IDB when SimView is unavailable. */
      }
    }
    const idb = providers.find((provider) => provider.kind === 'idb' && provider.available);
    if (!idb || !idb.capabilities?.has('describe')) return null;
    try {
      const output = await this.options.runner.execFile(idb.command, [...idb.args, 'describe', '--udid', target.id, '--json'], { maxBuffer: 128 * 1024 });
      const parsed = JSON.parse(output.toString('utf8')) as Record<string, unknown>;
      const dimensions = (parsed.screen_dimensions ?? parsed.screenDimensions) as Record<string, unknown> | undefined;
      const width = Number(dimensions?.width_points ?? dimensions?.widthPoints);
      const height = Number(dimensions?.height_points ?? dimensions?.heightPoints);
      return Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0 ? { width, height, simviewUnavailable: Boolean(simview) } : null;
    } catch { return null; }
  }

  async button(target: NativeInputTarget, button: string): Promise<NativeDispatchResult> {
    if (this.closed) return result(target.platform === 'android' ? 'adb' : 'none', 'unavailable', false, 'Native input controller is closed');
    if (target.platform === 'android') {
      const keycodes: Record<string, string> = {
        HOME: '3', BACK: '4', VOLUME_UP: '24', VOLUME_DOWN: '25', POWER: '26', ENTER: '66', DELETE: '67',
      };
      const code = keycodes[button];
      return code ? this.adb(target, ['shell', 'input', 'keyevent', code], `press ${button}`) : result('adb', 'unsupported', false, `Unsupported Android button ${button}`);
    }
    const simviewButton: Record<string, string> = { HOME: 'home', POWER: 'lock', VOLUME_UP: 'volume-up', VOLUME_DOWN: 'volume-down' };
    if (button === 'ENTER' || button === 'DELETE') {
      const key = button === 'ENTER' ? 'return' : 'delete';
      const hidCode = IOS_HID_KEY_CODES[button];
      return this.dispatchSimViewOrIdb(target, 'press_key', { key, hidCode });
    }
    const selected = simviewButton[button];
    if (!selected) return result('none', 'unsupported', false, `Unsupported iOS button ${button}`);
    return this.dispatchSimViewOrIdb(target, 'press_button', { button: selected });
  }

  private async adb(target: NativeInputTarget, args: string[], description: string): Promise<NativeDispatchResult> {
    try {
      await this.options.runner.execFile('adb', ['-s', target.id, ...args], { maxBuffer: 64 * 1024 });
      return result('adb', 'handled', true, `${description} dispatched to ${target.id}`);
    } catch (error) {
      return result('adb', 'failed', false, error instanceof Error ? error.message : String(error), 'unknown');
    }
  }

  private async dispatchSimViewOrIdb(
    target: NativeInputTarget,
    operation: string,
    args: Record<string, unknown>,
    inActionQueue = false,
    deadline = this.simviewDeadline(),
    skipSimView = false,
  ): Promise<NativeDispatchResult> {
    const providers = await this.providersFor(target, deadline);
    let fallback: NativeDispatchResult | undefined;
    for (const provider of providers) {
      if (!provider.available) continue;
      if (skipSimView && provider.kind === 'simview') continue;
      const dispatched = provider.kind === 'simview'
        ? await this.simview(target, operation, args, provider, inActionQueue, deadline)
        : await this.idb(target, operation, args, provider);
      if (dispatched.status === 'unavailable' || dispatched.status === 'unsupported') {
        fallback = dispatched;
        continue;
      }
      return dispatched;
    }
    return fallback ?? result('none', 'unavailable', false, 'No supported native input provider is installed');
  }

  private async idb(target: NativeInputTarget, operation: string, args: Record<string, unknown>, provider: Provider): Promise<NativeDispatchResult> {
    let capability: string;
    switch (operation) {
      case 'long_press': capability = 'long_press'; break;
      case 'swipe': capability = 'swipe-duration'; break;
      case 'type_text': capability = 'text'; break;
      case 'press_button': capability = 'button'; break;
      case 'press_key': capability = 'key'; break;
      default: capability = 'tap'; break;
    }
    if (!provider.capabilities?.has(capability)) {
      return result('idb', 'unsupported', false, `IDB does not advertise ${operation}`);
    }
    const common = ['--udid', target.id];
    // IDB's CLI accepts integer logical device points for taps and swipes.
    const pointArgument = (value: unknown) => String(Math.round(Number(value)));
    let command: string[];
    switch (operation) {
      case 'tap': command = ['ui', 'tap', pointArgument(args.x), pointArgument(args.y), ...common]; break;
      case 'long_press': command = ['ui', 'tap', pointArgument(args.x), pointArgument(args.y), '--duration', String(Number(args.durationMs) / 1000), ...common]; break;
      case 'swipe': {
        const from = args.from as { x: number; y: number };
        const to = args.to as { x: number; y: number };
        command = ['ui', 'swipe', pointArgument(from.x), pointArgument(from.y), pointArgument(to.x), pointArgument(to.y), '--duration', String(Number(args.durationMs) / 1000), ...common]; break;
      }
      case 'type_text':
        if ([...String(args.text)].some((character) => (character.codePointAt(0) ?? 0) > 0x7f)) return result('idb', 'unsupported', false, 'IDB text input only supports ASCII');
        command = ['ui', 'text', String(args.text), ...common];
        break;
      case 'press_button': {
        const idbButton: Record<string, string> = { home: 'HOME', lock: 'LOCK' };
        const button = idbButton[String(args.button)];
        if (!button || !provider.buttons?.has(button.toLowerCase())) return result('idb', 'unsupported', false, `IDB cannot press ${String(args.button)}`);
        command = ['ui', 'button', button, ...common]; break;
      }
      case 'press_key':
        command = ['ui', 'key', String(args.hidCode), ...common]; break;
      default: return result('idb', 'unsupported');
    }
    try {
      await this.options.runner.execFile(provider.command, [...provider.args, ...command], { maxBuffer: 256 * 1024 });
      return result('idb', 'handled', true);
    } catch (error) {
      return result('idb', 'failed', false, error instanceof Error ? error.message : String(error), 'unknown');
    }
  }

  private simview(
    target: NativeInputTarget,
    operation: string,
    args: Record<string, unknown>,
    provider: Provider,
    inActionQueue = false,
    deadline?: number,
  ): Promise<NativeDispatchResult> {
    return inActionQueue
      ? this.simviewInternal(target, operation, args, provider, deadline)
      : this.withActionQueue(() => this.simviewInternal(target, operation, args, provider, deadline));
  }

  private async simviewInternal(
    target: NativeInputTarget,
    operation: string,
    args: Record<string, unknown>,
    provider: Provider,
    requestDeadline?: number,
  ): Promise<NativeDispatchResult> {
    if (this.closed) return result('simview', 'unavailable', false, 'Native input controller is closed');
    const deadline = requestDeadline ?? this.simviewDeadline();
    let session: SimViewSession;
    try {
      session = await this.getSession(target, provider, deadline);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A failed handshake happens before SimView receives an input action.
      // In auto mode this is safe to fall through to IDB; reporting an
      // unknown dispatch would stop the chain and could strand a working
      // native backend behind a transient SimView connection failure.
      return result('simview', 'unavailable', false, message, 'not-sent');
    }
    return this.withSessionQueue(session, async () => {
      if (this.closed) return result('simview', 'unavailable', false, 'Native input controller is closed');
      try {
        await this.refreshSession(session, deadline);
      } catch (error) {
        await this.invalidateSession(session, deadline);
        // Refresh only reads the session/device state and precedes the actual
        // input call, so a refresh failure cannot have dispatched input.
        return result('simview', 'unavailable', false, error instanceof Error ? error.message : String(error), 'not-sent');
      }
      const tool = operation === 'long_press' ? 'long_press' : operation;
      const input = session.capabilities.input as Record<string, unknown> | undefined;
      if (!session.tools.has(tool)) return result('simview', 'unsupported', false, `SimView does not provide ${tool}`);
      if (operation === 'type_text') {
        const supportsText = input?.text === 'ascii' || input?.text === 'unicode';
        const requiresUnicode = /[^\x00-\x7F]/u.test(String(args.text));
        if (!supportsText || (input?.text === 'ascii' && requiresUnicode)) {
          return result('simview', 'unsupported', false, 'SimView does not support this text input');
        }
      }
      if ((operation === 'tap' || operation === 'long_press' || operation === 'swipe') && input?.touch !== true) return result('simview', 'unsupported', false, 'SimView does not support touch input');
      if (operation === 'press_button' && (!Array.isArray(input?.buttons) || !input.buttons.includes(args.button))) return result('simview', 'unsupported', false, `SimView does not support button ${String(args.button)}`);
      // SimView 0.4.0 exposes press_key without a per-device key list. Newer
      // versions advertise one, so honor it when present while retaining
      // compatibility with that public release.
      if (operation === 'press_key' && Array.isArray(input?.keys) && !input.keys.includes(args.key)) return result('simview', 'unsupported', false, `SimView does not support key ${String(args.key)}`);
      if (Date.now() >= deadline) return result('simview', 'unavailable', false, 'SimView setup timed out before input dispatch', 'not-sent');
      const normalized = this.normalizeArgs(operation, args, session.width, session.height);
      try {
        const response = await session.client.callTool({ name: tool, arguments: normalized });
        const structured = readStructuredResult(response);
        const interaction = structured.interaction && typeof structured.interaction === 'object'
          ? structured.interaction as Record<string, unknown>
          : undefined;
        const accepted = typeof interaction?.accepted === 'boolean' ? interaction.accepted : structured.accepted;
        const inputDispatched = typeof interaction?.inputDispatched === 'boolean'
          ? interaction.inputDispatched
          : typeof structured.inputDispatched === 'boolean' ? structured.inputDispatched : undefined;
        const dispatched = inputDispatched === true;
        if (response.isError) return result('simview', 'failed', dispatched, 'SimView action result is uncertain', dispatched ? 'submitted' : 'unknown');
        if (interaction?.safeToContinue === false || structured.safeToContinue === false) {
          return result(
            'simview',
            'failed',
            dispatched,
            'SimView reported that it is unsafe to continue after the action',
            dispatchEvidence(inputDispatched),
          );
        }
        if (accepted === false) return result('simview', 'failed', dispatched, 'SimView rejected the action', dispatched ? 'submitted' : 'not-sent');
        if (accepted === true && inputDispatched === false) {
          // In auto mode SimView has explicitly proved that no input was
          // dispatched, so another provider may safely take over. Preserve a
          // terminal failure for explicit SimView selection.
          return result(
            'simview',
            this.config.nativeBackend === 'auto' ? 'unsupported' : 'failed',
            false,
            'SimView accepted the request without dispatching input',
          );
        }
        if (accepted !== true) return result('simview', 'failed', dispatched, 'SimView returned no accepted action receipt', dispatched ? 'submitted' : 'unknown');
        return result('simview', 'handled', true);
      } catch (error) {
        return result('simview', 'failed', false, error instanceof Error ? error.message : String(error), 'unknown');
      }
    });
  }

  private normalizeArgs(operation: string, args: Record<string, unknown>, width: number, height: number): Record<string, unknown> {
    const point = (x: number, y: number) => normalizeLogicalPoint({ x, y }, width, height);
    if (operation === 'tap' || operation === 'long_press') return { ...point(Number(args.x), Number(args.y)), ...(operation === 'long_press' ? { durationMs: args.durationMs } : {}) };
    if (operation === 'swipe') {
      const from = args.from as { x: number; y: number }; const to = args.to as { x: number; y: number };
      return { from: point(from.x, from.y), to: point(to.x, to.y), durationMs: args.durationMs };
    }
    if (operation === 'press_key') return { key: args.key };
    return args;
  }

  private async getSession(target: NativeInputTarget, provider: Provider, deadline = this.simviewDeadline()): Promise<SimViewSession> {
    if (this.closed) throw new Error('Native input controller is closed');
    const deviceId = `${target.platform}:${target.id}`;
    if (this.session) {
      if (this.session.closed) this.session = null;
      else if (this.session.deviceId === deviceId) return this.session;
    }
    if (this.session) {
      const session = this.session;
      return this.withSessionQueue(session, async () => {
        try {
          if (this.closed) throw new Error('Native input controller is closed');
          const switched = await this.simviewRequest(
            () => session.client.callTool({ name: 'connect_device', arguments: { deviceId, observationMode: 'semantic' } }),
            `connect to ${deviceId}`,
            deadline,
          );
          if (switched.isError) throw new Error(`SimView could not connect to ${deviceId}`);
          session.deviceId = deviceId;
          await this.refreshSession(session, deadline);
          return session;
        } catch (error) {
          await this.invalidateSession(session, deadline);
          throw error;
        }
      });
    }
    if (this.pendingSession) return this.pendingSession.then(() => this.getSession(target, provider, deadline));
    this.pendingSession = this.createSession(target, provider, deadline);
    try { return await this.pendingSession; } finally { this.pendingSession = null; }
  }

  private async createSession(target: NativeInputTarget, provider: Provider, deadline = this.simviewDeadline()): Promise<SimViewSession> {
    const deviceId = `${target.platform}:${target.id}`;
    const mcpArgs = provider.args.at(-1) === 'mcp' ? provider.args : [...provider.args, 'mcp'];
    const created = this.options.simviewClientFactory?.(provider.command, mcpArgs);
    const transport = created?.transport ?? new StdioClientTransport({ command: provider.command, args: mcpArgs, stderr: 'pipe' });
    const client: SimViewClientLike = created?.client ?? new Client({ name: 'metro-mcp', version: '0.15.0' }, { capabilities: {} });
    const resource: SimViewResource = { client, transport, closePromise: null };
    this.resources.add(resource);
    try {
      await this.simviewRequest(() => client.connect(transport), 'connect', deadline);
      if (this.closed) throw new Error('Native input controller is closed');
      const tools = await this.simviewRequest(() => client.listTools(), 'list tools', deadline);
      if (this.closed) throw new Error('Native input controller is closed');
      if (!tools.tools.some((tool) => tool.name === 'connect_device')) throw new Error('SimView MCP server does not provide connect_device');
      const connected = await this.simviewRequest(
        () => client.callTool({ name: 'connect_device', arguments: { deviceId, observationMode: 'semantic' } }),
        `connect to ${deviceId}`,
        deadline,
      );
      if (this.closed) throw new Error('Native input controller is closed');
      if (connected.isError) throw new Error('SimView could not connect to the selected device');
      const state = await this.simviewRequest(() => client.callTool({ name: 'get_simview_state', arguments: {} }), 'read device state', deadline);
      if (this.closed) throw new Error('Native input controller is closed');
      const session = await this.sessionFromState(resource, deviceId, tools.tools.map((tool) => tool.name), state, deadline);
      if (this.closed) throw new Error('Native input controller is closed');
      this.session = session;
      return session;
    } catch (error) {
      await this.closeResourceBeforeDeadline(resource, deadline);
      throw error;
    }
  }

  private async sessionFromState(
    resource: SimViewResource,
    deviceId: string,
    toolNames: string[],
    state: SimViewCallResult,
    deadline = this.simviewDeadline(),
  ): Promise<SimViewSession> {
    const { client, transport } = resource;
    if (this.closed) throw new Error('Native input controller is closed');
    const structured = readStructuredResult(state);
    const device = structured.device as Record<string, unknown> | undefined;
    if (!device || device.id !== deviceId) {
      throw new Error(`SimView selected unexpected device ${String(device?.id ?? 'unknown')}`);
    }
    const stateWidth = positiveNumber(device.pointWidth, 0);
    const stateHeight = positiveNumber(device.pointHeight, 0);
    const capabilities = device?.capabilities as Record<string, unknown> | undefined;
    if (!capabilities) throw new Error('SimView did not report device capabilities');
    let width = stateWidth;
    let height = stateHeight;
    if (toolNames.includes('observe_screen')) {
      if (this.closed) throw new Error('Native input controller is closed');
      const observation = await this.simviewRequest(
        () => client.callTool({ name: 'observe_screen', arguments: { mode: 'semantic' } }),
        'observe screen geometry',
        deadline,
      );
      if (observation.isError) throw new Error('SimView did not report a semantic observation for device geometry');
      const observed = extractObservationGeometry(readStructuredResult(observation));
      if (observed) {
        width = observed.width;
        height = observed.height;
      }
    }
    if (!width || !height) throw new Error('SimView did not report logical device geometry');
    return { client, transport, resource, deviceId, width, height, capabilities, tools: new Set(toolNames), queue: Promise.resolve(), closed: false };
  }

  private async refreshSession(session: SimViewSession, deadline = this.simviewDeadline()): Promise<void> {
    if (session.closed) throw new Error('SimView session is closed');
    const state = await this.simviewRequest(() => session.client.callTool({ name: 'get_simview_state', arguments: {} }), 'refresh device state', deadline);
    if (state.isError) throw new Error('SimView could not refresh the selected device state');
    const refreshed = await this.sessionFromState(session.resource, session.deviceId, [...session.tools], state, deadline);
    session.width = refreshed.width;
    session.height = refreshed.height;
    session.capabilities = refreshed.capabilities;
  }

  /**
   * Bound every SimView request made before native input dispatch. The MCP
   * client cannot cancel a stalled call, so callers invalidate and close its
   * resource after this deadline before considering a fallback provider.
   */
  private simviewDeadline(): number {
    return Date.now() + this.simviewRequestTimeoutMs;
  }

  private async simviewRequest<T>(operation: () => Promise<T>, description: string, deadline = this.simviewDeadline()): Promise<T> {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(`SimView ${description} timed out before the request started`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`SimView ${description} timed out after ${this.simviewRequestTimeoutMs}ms`)), remaining);
    });
    try {
      return await Promise.race([Promise.resolve().then(operation), timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async invalidateSession(session: SimViewSession, deadline = this.simviewDeadline()): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    if (this.session === session) this.session = null;
    await this.closeResourceBeforeDeadline(session.resource, deadline);
  }

  private async closeResourceBeforeDeadline(resource: SimViewResource, deadline: number): Promise<void> {
    const close = this.closeResource(resource);
    const remaining = Math.max(0, deadline - Date.now());
    if (remaining > 0) {
      await settleWithin(close, remaining);
    } else {
      // The resource is detached above and closeResource has already claimed
      // its closePromise. Consume late failures without extending fallback.
      void close.catch(() => {});
    }
    // Do not retain a resource whose bounded cleanup has already been handed
    // off. Its closePromise remains the once-only guard for late completion.
    this.resources.delete(resource);
  }

  private async withSessionQueue<T>(session: SimViewSession, operation: () => Promise<T>): Promise<T> {
    const prior = session.queue;
    let release!: () => void;
    session.queue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private async withActionQueue<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.actionQueue;
    let release!: () => void;
    this.actionQueue = new Promise<void>((resolve) => { release = resolve; });
    await prior;
    try { return await operation(); } finally { release(); }
  }

  private registerCleanup(): void {
    if (this.cleanupRegistered || !this.options.registerCleanup) return;
    this.cleanupRegistered = true;
    this.options.registerCleanup(() => this.close());
  }

  async close(): Promise<void> {
    if (this.cleanupPromise) return this.cleanupPromise;
    this.closed = true;
    const session = this.session;
    const resources = [...this.resources];
    if (session) {
      session.closed = true;
      this.session = null;
    }
    this.cleanupPromise = (async () => {
      // Mark the session closed before starting transport teardown. This lets
      // an invalidateSession racing with cleanup observe the guard and avoid a
      // second close while the client call that is being interrupted drains.
      // Close every owned client first, including a client still blocked in
      // connect/listTools/callTool. The bounded wait keeps plugin shutdown
      // from inheriting a provider that never settles.
      await Promise.all(resources.map((resource) => settleWithin(this.closeResource(resource))));
      await settleWithin(this.actionQueue.catch(() => {}));
      if (session) await settleWithin(session.queue.catch(() => {}));
    })();
    return this.cleanupPromise;
  }

  private async closeResource(resource: SimViewResource): Promise<void> {
    if (!resource.closePromise) {
      resource.closePromise = closeSimView(resource.client, resource.transport);
      void resource.closePromise.then(
        () => this.resources.delete(resource),
        () => this.resources.delete(resource),
      );
    }
    await resource.closePromise;
  }
}

function positiveNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Encode one argument for Android's remote `input text` shell parser. */
function encodeAdbInputText(text: string): string {
  const encoded = text.replace(/ /g, '%s');
  return `'${encoded.replace(/'/g, `'\\''`)}'`;
}

function extractObservationGeometry(structured: Record<string, unknown>): { width: number; height: number } | null {
  const candidates: unknown[] = [
    structured.viewport,
    structured.screen,
    (structured.snapshot as Record<string, unknown> | undefined)?.screen,
    (structured.elements as Record<string, unknown> | undefined)?.screen,
    (structured.screenContext as Record<string, unknown> | undefined)?.viewport,
    (structured.screenContext as Record<string, unknown> | undefined)?.screen,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue;
    const value = candidate as Record<string, unknown>;
    const width = positiveNumber(value.width ?? value.pointWidth, 0);
    const height = positiveNumber(value.height ?? value.pointHeight, 0);
    if (width > 0 && height > 0) return { width, height };
  }
  return null;
}

async function closeSimView(client: SimViewClientLike, transport: SimViewTransportLike): Promise<void> {
  // Resolve each call in its own microtask so a synchronous close failure
  // cannot prevent the transport from receiving its abort signal.
  await Promise.allSettled([
    Promise.resolve().then(() => client.close()),
    Promise.resolve().then(() => transport.close()),
  ]);
}

async function settleWithin(promise: Promise<unknown>, timeoutMs = 500): Promise<void> {
  await Promise.race([promise.then(() => undefined, () => undefined), new Promise<void>((resolve) => setTimeout(resolve, timeoutMs))]);
}

function readStructuredResult(value: SimViewCallResult): Record<string, unknown> {
  if (value.structuredContent && typeof value.structuredContent === 'object')
    return value.structuredContent as Record<string, unknown>;
  const text = value.content?.find((block) => block.type === 'text')?.text;
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function findAccessibilityPoint(raw: string, label: string): { point: { x: number; y: number } | null; ambiguous: boolean } {
  let values: unknown[];
  try { values = [JSON.parse(raw)]; } catch {
    values = raw.split(/\r?\n/).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
  }
  const stack: unknown[] = [...values];
  const points: Array<{ x: number; y: number }> = [];
  while (stack.length) {
    const value = stack.pop();
    if (!value || typeof value !== 'object') continue;
    if (Array.isArray(value)) { stack.push(...value); continue; }
    const object = value as Record<string, unknown>;
    const names = [object.label, object.name, object.title, object.value, object.accessibilityLabel];
    if (names.some((name) => name === label)) {
      const frame = object.frame ?? object.bounds ?? object.rect;
      if (frame && typeof frame === 'object') {
        const f = frame as Record<string, unknown>;
        const x = Number(f.x ?? f.minX); const y = Number(f.y ?? f.minY);
        const width = Number(f.width ?? f.w ?? (Number(f.maxX) - x));
        const height = Number(f.height ?? f.h ?? (Number(f.maxY) - y));
        if ([x, y, width, height].every(Number.isFinite)) points.push({ x: x + width / 2, y: y + height / 2 });
      }
    }
    stack.push(...Object.values(object));
  }
  return { point: points.length === 1 ? points[0] : null, ambiguous: points.length > 1 };
}

function simViewFrameCenter(value: unknown, width: number, height: number): { x: number; y: number } | null {
  if (!value || typeof value !== 'object') return null;
  const object = value as Record<string, unknown>;
  const frame = object.frame && typeof object.frame === 'object' ? object.frame as Record<string, unknown> : object;
  const normalized = frame.normalized && typeof frame.normalized === 'object' ? frame.normalized as Record<string, unknown> : undefined;
  const points = frame.points && typeof frame.points === 'object' ? frame.points as Record<string, unknown> : undefined;
  const center = (candidate: Record<string, unknown> | undefined, scaleX: number, scaleY: number) => {
    if (!candidate) return null;
    const x = Number(candidate.x);
    const y = Number(candidate.y);
    const frameWidth = Number(candidate.width);
    const frameHeight = Number(candidate.height);
    if (![x, y, frameWidth, frameHeight].every(Number.isFinite) || frameWidth < 0 || frameHeight < 0) return null;
    const centerX = (x + frameWidth / 2) * scaleX;
    const centerY = (y + frameHeight / 2) * scaleY;
    if (centerX < 0 || centerX > 1 || centerY < 0 || centerY > 1) return null;
    return { x: centerX, y: centerY };
  };
  // SimView exposes both logical points and normalized frame coordinates. Use
  // normalized values first so a stale point geometry cannot skew the action.
  return center(normalized, 1, 1) ?? center(points, 1 / width, 1 / height) ?? center(frame, 1 / width, 1 / height);
}
