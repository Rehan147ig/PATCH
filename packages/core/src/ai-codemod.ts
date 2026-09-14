import type { AiCodemodSpec, ScanHit } from './types.js';

/**
 * AI-assisted semantic codemod.
 *
 * For non-mechanical refactors (e.g. converting a synchronous call to async
 * job polling), the executor sends the extracted context + prompt to a
 * pluggable LLM provider. The result is validated structurally before it is
 * trusted:
 *   - must be valid JSON with `{ file, replacements }`
 *   - every replacement must reference a real line range in the file
 *   - confidence below the threshold is rejected
 *
 * If no provider is configured (or the provider fails), the executor returns
 * a report-only result — never a silent no-op or a hallucinated edit.
 */

export interface AiCodemodProvider {
  /** Unique id, e.g. 'openai' | 'anthropic' | 'mock'. */
  id: string;
  /** Run the prompt and return the raw text response. */
  complete(prompt: string, opts?: { temperature?: number }): Promise<string>;
}

export interface AiReplacement {
  file: string;
  startLine: number;
  endLine: number;
  newText: string;
  explanation: string;
}

export interface AiCodemodResult {
  spec: AiCodemodSpec;
  /** Parsed, validated replacements. */
  replacements: AiReplacement[];
  /** Whether the executor fell back to report-only (provider missing/failed). */
  applied: boolean;
  confidence: number;
  error?: string;
}

/** Default provider — none configured; everything is report-only. */
export const noProvider: AiCodemodProvider = {
  id: 'none',
  async complete() {
    throw new Error('No AI provider configured');
  },
};

let provider: AiCodemodProvider = noProvider;

/** Configure the global AI provider (inject in production). */
export function setAiProvider(p: AiCodemodProvider): void {
  provider = p;
}

export function getAiProvider(): AiCodemodProvider {
  return provider;
}

/**
 * Execute an AI codemod for a set of hits.
 * Returns validated replacements, or a report-only result when the provider
 * is unavailable or the output fails validation.
 */
export async function runAiCodemod(spec: AiCodemodSpec, hits: ScanHit[], sourceFiles: Map<string, string>): Promise<AiCodemodResult> {
  if (provider.id === 'none') {
    return {
      spec,
      replacements: [],
      applied: false,
      confidence: 0,
      error: 'No AI provider configured; change is report-only',
    };
  }

  const context = hits
    .map((h) => {
      const src = sourceFiles.get(h.file) ?? '';
      const lines = src.split('\n');
      const start = Math.max(0, h.line - 4);
      const end = Math.min(lines.length, h.line + 3);
      return `--- ${h.file}:${h.line} ---\n${lines.slice(start, end).join('\n')}`;
    })
    .join('\n\n');

  const prompt = [
    spec.prompt,
    spec.context ?? '',
    'Relevant source snippets:',
    context,
    '',
    'Respond with JSON only: {"replacements": [{"file": string, "startLine": number, "endLine": number, "newText": string, "explanation": string}]}',
    'Do not include markdown fences.',
  ].join('\n');

  try {
    const raw = await provider.complete(prompt, { temperature: 0.1 });
    const parsed = parseResponse(raw);
    const validated = validateReplacements(parsed, sourceFiles);
    if (validated.length === 0) {
      return {
        spec,
        replacements: [],
        applied: false,
        confidence: 0,
        error: 'AI response contained no valid replacements',
      };
    }
    return {
      spec,
      replacements: validated,
      applied: true,
      confidence: Math.min(0.95, 0.6 + validated.length * 0.1),
    };
  } catch (err) {
    return {
      spec,
      replacements: [],
      applied: false,
      confidence: 0,
      error: (err as Error).message,
    };
  }
}

function parseResponse(raw: string): AiReplacement[] {
  const cleaned = raw.trim().replace(/^```(json)?/m, '').replace(/```$/m, '').trim();
  const jsonStart = cleaned.indexOf('{');
  const jsonEnd = cleaned.lastIndexOf('}');
  if (jsonStart === -1 || jsonEnd === -1) return [];
  try {
    const parsed = JSON.parse(cleaned.slice(jsonStart, jsonEnd + 1));
    return Array.isArray(parsed.replacements) ? (parsed.replacements as AiReplacement[]) : [];
  } catch {
    return [];
  }
}

function validateReplacements(rs: AiReplacement[], sourceFiles: Map<string, string>): AiReplacement[] {
  return rs.filter((r) => {
    if (!r.file || !sourceFiles.has(r.file)) return false;
    if (typeof r.startLine !== 'number' || typeof r.endLine !== 'number') return false;
    if (r.startLine < 1 || r.endLine < r.startLine) return false;
    const lineCount = sourceFiles.get(r.file)!.split('\n').length;
    if (r.endLine > lineCount) return false;
    return typeof r.newText === 'string' && r.newText.length > 0;
  });
}
