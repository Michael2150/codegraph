import { execFileSync } from 'child_process';
import * as path from 'path';
import type { ExtractionResult, Node, Edge, UnresolvedReference, Language } from '../types';

// Binary location: CODEGRAPH_ROSLYN_BIN env var (dev) or bundled binary (prod)
function getRoslynBin(): string {
  if (process.env.CODEGRAPH_ROSLYN_BIN) return process.env.CODEGRAPH_ROSLYN_BIN;
  let platform: string;
  if (process.platform === 'win32') {
    platform = 'win-x64';
  } else if (process.platform === 'darwin') {
    platform = process.arch === 'arm64' ? 'osx-arm64' : 'osx-x64';
  } else {
    platform = process.arch === 'arm64' ? 'linux-arm64' : 'linux-x64';
  }
  const ext = process.platform === 'win32' ? '.exe' : '';
  return path.join(__dirname, `../../bin/codegraph-roslyn-${platform}${ext}`);
}

// ── Roslyn JSON schema ────────────────────────────────────────────────────────

interface RoslynNode {
  id: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  visibility: string | null;
  isStatic: boolean;
  isAsync: boolean;
  parentId: string | null;
}

interface RoslynEdge {
  kind: string;
  fromId: string;
  toId: string;
  toQualifiedName: string;
}

interface RoslynUnresolvedRef {
  fromId: string;
  toQualifiedName: string;
  kind: string;
}

interface RoslynOutput {
  nodes: RoslynNode[];
  edges: RoslynEdge[];
  unresolvedReferences: RoslynUnresolvedRef[];
  errors: Array<{ message: string }>;
}

// ── Extractor ─────────────────────────────────────────────────────────────────

export class RoslynExtractor {
  private readonly language: Language;

  constructor(
    private readonly filePath: string,
    private readonly source: string
  ) {
    this.language = path.extname(filePath).toLowerCase() === '.vb' ? 'vbnet' : 'csharp';
  }

  extract(): ExtractionResult {
    const startTime = Date.now();
    let raw: RoslynOutput;

    try {
      // Pass source via stdin so the binary does not need to locate the file
      // on disk relative to its own working directory. The --file arg is kept
      // for node IDs and qualified name generation inside the binary.
      const stdout = execFileSync(getRoslynBin(), ['--file', this.filePath, '--stdin'], {
        encoding: 'utf8',
        input: this.source,
        timeout: 30_000,
        maxBuffer: 50 * 1024 * 1024,
      });
      raw = JSON.parse(stdout) as RoslynOutput;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        nodes: [],
        edges: [],
        unresolvedReferences: [],
        errors: [{ message: `codegraph-roslyn failed: ${msg}`, severity: 'error' }],
        durationMs: Date.now() - startTime,
      };
    }

    const now = Date.now();
    const nodeIds = new Set(raw.nodes.map((n) => n.id));

    const nodes: Node[] = raw.nodes.map((n) => ({
      id: n.id,
      kind: n.kind as Node['kind'],
      name: n.name,
      qualifiedName: n.qualifiedName,
      filePath: n.filePath,
      language: this.language,
      startLine: n.startLine,
      endLine: n.endLine,
      startColumn: 0,
      endColumn: 0,
      visibility: n.visibility as Node['visibility'],
      isStatic: n.isStatic,
      isAsync: n.isAsync,
      updatedAt: now,
    }));

    const edges: Edge[] = [];
    const unresolvedReferences: UnresolvedReference[] = [];

    for (const e of raw.edges) {
      if (nodeIds.has(e.toId)) {
        edges.push({ kind: e.kind as Edge['kind'], source: e.fromId, target: e.toId });
      } else {
        unresolvedReferences.push({
          fromNodeId: e.fromId,
          referenceName: e.toQualifiedName || e.toId,
          referenceKind: e.kind as Edge['kind'],
          line: 0,
          column: 0,
          filePath: this.filePath,
        });
      }
    }

    for (const u of raw.unresolvedReferences) {
      unresolvedReferences.push({
        fromNodeId: u.fromId,
        referenceName: u.toQualifiedName,
        referenceKind: u.kind as Edge['kind'],
        line: 0,
        column: 0,
        filePath: this.filePath,
      });
    }

    const errors = raw.errors.map((e) => ({
      message: e.message,
      severity: 'error' as const,
    }));

    return { nodes, edges, unresolvedReferences, errors, durationMs: Date.now() - startTime };
  }
}
