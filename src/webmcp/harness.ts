/**
 * A stand-in for `document.modelContext`, matching Chrome's real API.
 *
 * SeriesSafe registers its tools against the browser's WebMCP implementation
 * when there is one. This harness exists for two other cases: verifying the
 * tool layer in a plain browser or a test runner, and letting someone try the
 * agent workflow when their browser has not enabled WebMCP yet.
 *
 * It deliberately mirrors Chrome 151's observed behaviour *including its
 * strictness*, because a permissive stand-in hides real bugs:
 *
 *   - `registerTool()` resolves with `undefined`.
 *   - `getTools()` returns plain objects whose `inputSchema` is a JSON
 *     **string**, alongside `name`, `description`, `title` and `origin`.
 *   - `executeTool()` takes exactly two arguments: a tool object obtained from
 *     `getTools()`, and the arguments as a JSON **string**. Passing a name, or
 *     passing an object instead of a string, throws — as it does in Chrome.
 *   - `execute()` receives the parsed arguments as an object.
 *
 * It is never installed over a real implementation, and the UI always says
 * which one is in use.
 */

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: unknown;
  execute: (args: any, options?: { signal?: AbortSignal }) => Promise<string> | string;
}

/** The shape `getTools()` hands back, as observed in Chrome 151. */
export interface RegisteredTool {
  name: string;
  description: string;
  title: string;
  /** Serialized JSON Schema, matching Chrome. */
  inputSchema: string;
  origin: string;
}

class LocalModelContext extends EventTarget {
  readonly isSeriesSafeHarness = true;
  #tools = new Map<string, ToolDef>();

  async registerTool(def: ToolDef, options?: { signal?: AbortSignal }): Promise<undefined> {
    if (!def?.name || typeof def.execute !== 'function') {
      throw new TypeError("Failed to execute 'registerTool' on 'ModelContext': a name and execute are required");
    }
    this.#tools.set(def.name, def);
    options?.signal?.addEventListener('abort', () => {
      this.#tools.delete(def.name);
      this.dispatchEvent(new Event('toolchange'));
    });
    this.dispatchEvent(new Event('toolchange'));
    return undefined;
  }

  async getTools(): Promise<RegisteredTool[]> {
    const origin = typeof location !== 'undefined' ? location.origin : 'null';
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      title: t.name,
      inputSchema: JSON.stringify(t.inputSchema),
      origin,
    }));
  }

  async executeTool(tool: RegisteredTool, args: string, options?: { signal?: AbortSignal }): Promise<string | null> {
    if (arguments.length < 2) {
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': 2 arguments required, but only " +
          `${arguments.length} present.`,
      );
    }
    if (!tool || typeof tool !== 'object' || typeof (tool as RegisteredTool).name !== 'string') {
      throw new TypeError(
        "Failed to execute 'executeTool' on 'ModelContext': The provided value is not of type 'RegisteredTool'.",
      );
    }
    const def = this.#tools.get(tool.name);
    if (!def) throw new Error(`No tool named "${tool.name}" is registered right now.`);

    let parsed: unknown;
    try {
      parsed = typeof args === 'string' ? JSON.parse(args || '{}') : undefined;
    } catch {
      parsed = undefined;
    }
    if (parsed === undefined) throw new Error('Failed to parse input arguments');

    return await def.execute(parsed as any, options);
  }
}

/** True when the page is running against the local harness rather than a browser API. */
export function usingHarness(): boolean {
  return Boolean((document as any).modelContext?.isSeriesSafeHarness);
}

/** Install the harness only if the browser has no WebMCP implementation. */
export function installHarnessIfAbsent(): boolean {
  const d = document as any;
  if (d.modelContext || (navigator as any).modelContext) return false;
  d.modelContext = new LocalModelContext();
  return true;
}

/**
 * Call a tool the way the real API requires: resolve the `RegisteredTool` from
 * `getTools()`, then pass the arguments as a JSON string.
 *
 * Used by the scripted walkthrough so it exercises the same path an external
 * agent takes, on both the browser API and the harness.
 */
export async function callTool(
  mc: { getTools(): Promise<RegisteredTool[]>; executeTool(t: any, a: string): Promise<string | null> },
  name: string,
  args: Record<string, unknown> = {},
): Promise<string> {
  const tools = await mc.getTools();
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`No tool named "${name}" is registered right now.`);
  const result = await mc.executeTool(tool, JSON.stringify(args));
  return String(result ?? '');
}
