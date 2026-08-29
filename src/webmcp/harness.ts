/**
 * A spec-shaped stand-in for `document.modelContext`.
 *
 * SeriesSafe registers its tools against the real WebMCP API when the browser
 * provides one. This harness exists for two other cases: verifying the tool
 * layer in a plain browser or a test runner, and letting someone try the agent
 * workflow when their browser has not enabled WebMCP yet.
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

export interface HarnessContext extends EventTarget {
  registerTool(def: ToolDef, options?: { signal?: AbortSignal }): Promise<{ name: string }>;
  getTools(): Promise<Array<{ name: string; description: string; inputSchema: unknown }>>;
  executeTool(tool: string | { name: string }, args?: unknown, options?: { signal?: AbortSignal }): Promise<string>;
}

class LocalModelContext extends EventTarget implements HarnessContext {
  readonly isSeriesSafeHarness = true;
  #tools = new Map<string, ToolDef>();

  async registerTool(def: ToolDef, options?: { signal?: AbortSignal }): Promise<{ name: string }> {
    if (!def?.name || typeof def.execute !== 'function') {
      throw new TypeError('registerTool requires a name and an execute function');
    }
    this.#tools.set(def.name, def);
    options?.signal?.addEventListener('abort', () => {
      this.#tools.delete(def.name);
      this.dispatchEvent(new Event('toolchange'));
    });
    this.dispatchEvent(new Event('toolchange'));
    return { name: def.name };
  }

  async getTools() {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
    }));
  }

  async executeTool(tool: string | { name: string }, args: unknown = {}, options?: { signal?: AbortSignal }) {
    const name = typeof tool === 'string' ? tool : tool?.name;
    const def = name ? this.#tools.get(name) : undefined;
    if (!def) throw new Error(`No tool named "${name}" is registered right now.`);
    return await def.execute(args as any, options);
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
