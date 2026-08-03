import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, type StdioOptions } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type TestProcessScopeOptions = {
  label?: string;
  closeTimeoutMs?: number;
};

export type TestProcessSpawnOptions = SpawnOptionsWithoutStdio & {
  stdio?: StdioOptions;
};

const DEFAULT_CLOSE_TIMEOUT_MS = 3_000;

export class TestProcessScope {
  private readonly children = new Set<ChildProcess>();
  private readonly label: string;
  private readonly closeTimeoutMs: number;

  constructor(options: TestProcessScopeOptions = {}) {
    this.label = options.label ?? 'test-process-scope';
    this.closeTimeoutMs = positiveInteger(options.closeTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);
  }

  spawn(
    command: string,
    args: readonly string[] = [],
    options: TestProcessSpawnOptions = {},
  ): ChildProcessWithoutNullStreams {
    const child = spawnProcess(command, args, options);
    this.children.add(child);
    child.once('close', () => this.children.delete(child));
    child.once('error', () => this.children.delete(child));
    return child;
  }

  async run(
    command: string,
    args: readonly string[] = [],
    options: TestProcessSpawnOptions = {},
  ): Promise<number> {
    const child = this.spawn(command, args, { ...options, stdio: 'inherit' } as unknown as TestProcessSpawnOptions);
    return await new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code) => resolve(code ?? 1));
    });
  }

  async close(): Promise<void> {
    const children = [...this.children];
    for (const child of children) {
      if (!this.children.has(child)) continue;
      await closeChild(child, this.closeTimeoutMs);
    }
    if (this.children.size > 0) {
      throw new Error(this.label + ' retained ' + this.children.size + ' child process(es) after close');
    }
  }

  assertClean(): void {
    const active = [...this.children].filter((child) => !hasTerminated(child));
    if (active.length > 0) {
      throw new Error(this.label + ' has ' + active.length + ' active child process(es): ' + active.map((child) => child.pid ?? 'unknown').join(','));
    }
  }

  activeCount(): number {
    return [...this.children].filter((child) => !hasTerminated(child)).length;
  }
}

export function createTestProcessScope(options: TestProcessScopeOptions = {}): TestProcessScope {
  return new TestProcessScope(options);
}

export function nativeTestProcessScopePath(): string {
  if (process.platform !== 'win32') {
    throw new Error('the Rust test process scope is currently implemented for Windows only');
  }
  const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
  const executable = join(packageRoot, 'native', 'target', 'release', 'narada-test-process-scope.exe');
  if (!existsSync(executable)) {
    throw new Error('Rust test process scope is not built: ' + executable + '; run the mcp-e2e-harness build first');
  }
  return executable;
}

function spawnProcess(
  command: string,
  args: readonly string[],
  options: TestProcessSpawnOptions,
): ChildProcessWithoutNullStreams {
  const stdio: StdioOptions = options.stdio ?? ['pipe', 'pipe', 'pipe'];
  if (process.platform !== 'win32') {
    return spawn(command, [...args], {
      ...options,
      stdio,
      shell: false,
    }) as ChildProcessWithoutNullStreams;
  }
  return spawn(nativeTestProcessScopePath(), ['--', command, ...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    stdio,
    shell: false,
    windowsHide: true,
  }) as ChildProcessWithoutNullStreams;
}

async function closeChild(child: ChildProcess, timeoutMs: number): Promise<void> {
  const close = waitForTermination(child);
  if (child.stdin && !child.stdin.destroyed && !child.stdin.writableEnded) {
    child.stdin.end();
  }
  if (await resolvesWithin(close, timeoutMs)) return;
  try {
    child.kill();
  } catch {
    // The helper's Job Object performs descendant cleanup when its owner is killed.
  }
  if (!await resolvesWithin(close, timeoutMs)) {
    throw new Error('child process did not terminate after bounded cleanup: ' + (child.pid ?? 'unknown'));
  }
}

function hasTerminated(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

function waitForTermination(child: ChildProcess): Promise<void> {
  return new Promise<void>((resolvePromise) => {
    const finish = () => {
      child.off('close', finish);
      child.off('error', finish);
      resolvePromise();
    };
    child.once('close', finish);
    child.once('error', finish);
    if (hasTerminated(child)) finish();
  });
}

async function resolvesWithin(promise: Promise<void>, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | null = null;
  const timedOut = new Promise<boolean>((resolvePromise) => {
    timer = setTimeout(() => resolvePromise(false), timeoutMs);
  });
  const completed = promise.then(() => true);
  const result = await Promise.race([completed, timedOut]);
  if (timer) clearTimeout(timer);
  return result;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isInteger(value) && (value ?? 0) > 0 ? value as number : fallback;
}
