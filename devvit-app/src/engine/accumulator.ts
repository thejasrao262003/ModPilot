// Evidence Accumulator + Tool Registry — mirrors engine/orchestrator/tools.py.

import type { EvidenceEntry, Tool, ToolName, ToolResult } from './types';

export class EvidenceAccumulator {
  private readonly _entries: EvidenceEntry[] = [];

  append(result: ToolResult): EvidenceEntry {
    const entry: EvidenceEntry = {
      id: `ev-${this._entries.length + 1}`,
      tool: result.tool,
      status: result.status,
      summary: result.summary,
      detail: { ...result.detail },
      latencyMs: result.latencyMs,
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
    this._entries.push(entry);
    return entry;
  }

  byId(id: string): EvidenceEntry | undefined {
    return this._entries.find((e) => e.id === id);
  }

  entries(): EvidenceEntry[] {
    return [...this._entries];
  }

  successfulEntries(): EvidenceEntry[] {
    return this._entries.filter((e) => e.status === 'success');
  }

  get length(): number {
    return this._entries.length;
  }
}

export class ToolRegistry {
  private readonly _tools = new Map<ToolName, Tool>();

  register(tool: Tool): void {
    if (this._tools.has(tool.name)) {
      throw new Error(`tool already registered: ${tool.name}`);
    }
    this._tools.set(tool.name, tool);
  }

  get(name: ToolName): Tool {
    const t = this._tools.get(name);
    if (!t) throw new Error(`unknown tool: ${name}`);
    return t;
  }

  has(name: ToolName): boolean {
    return this._tools.has(name);
  }
}
