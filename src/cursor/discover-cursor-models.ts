import type { CursorAcpCloseOptions, CursorAcpStarted, CursorAcpStartOptions } from "#src/cursor/acp-client";
import {
  CursorAcpClient,
  extractCursorModelChoices,
  findCursorModelOption,
} from "#src/cursor/acp-client";

/** The live ACP model value, display name, and optional ACP option group. */
export interface DiscoveredCursorModel {
  value: string;
  name: string;
  current: boolean;
  group?: { id: string; name: string };
}

/** Narrow disposable ACP client boundary, intentionally injectable for discovery tests. */
export interface CursorModelDiscoveryClient {
  start(options: CursorAcpStartOptions): Promise<CursorAcpStarted>;
  close(options?: CursorAcpCloseOptions): Promise<void>;
}

export interface DiscoverCursorModelsOptions {
  cwd: string;
  signal?: AbortSignal;
  createClient?: () => CursorModelDiscoveryClient;
}

/**
 * Open one short-lived ACP session solely to inspect its advertised model option.
 * No prompt is sent; `CursorAcpClient.start()` supplies no MCP or ACP
 * filesystem/terminal capabilities. The client is always closed, including on abort.
 */
export async function discoverCursorModels(
  options: DiscoverCursorModelsOptions,
): Promise<DiscoveredCursorModel[]> {
  const client = (options.createClient ?? (() => new CursorAcpClient()))();
  let closeError: unknown;

  try {
    throwIfAborted(options.signal);
    const started = await client.start({ cwd: options.cwd, signal: options.signal });
    throwIfAborted(options.signal);
    const modelOption = findCursorModelOption(started.configOptions);
    if (!modelOption) {
      throw new Error("Cursor ACP did not advertise a model configuration option.");
    }
    return extractCursorModelChoices(modelOption).map((choice) => ({
      ...choice,
      current: modelOption.type === "select" && choice.value === modelOption.currentValue,
    }));
  } finally {
    try {
      await client.close({ graceful: !options.signal?.aborted });
    } catch (error) {
      closeError = error;
    }
    // The caller's cancellation takes precedence over best-effort cleanup errors.
    throwIfAborted(options.signal);
    if (closeError) throw closeError;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("The operation was aborted.", "AbortError");
  }
}
