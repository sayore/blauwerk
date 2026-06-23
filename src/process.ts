import type { RunResult } from "./types";

export class CommandError extends Error {
  constructor(public readonly result: RunResult) {
    super(`Command failed (${result.exitCode}): ${result.argv.join(" ")}\n${result.stderr || result.stdout}`);
  }
}

export async function run(argv: string[], options: {
  timeoutMs?: number;
  input?: string;
  allowFailure?: boolean;
  env?: Record<string, string>;
} = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const process = Bun.spawn(argv, {
    stdin: options.input === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...options.env },
  });
  if (options.input !== undefined) {
    const stdin = process.stdin;
    if (!stdin) throw new Error(`Failed to open stdin for: ${argv.join(" ")}`);
    stdin.write(options.input);
    stdin.end();
  }
  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    process.kill("SIGTERM");
    forceTimer = setTimeout(() => process.kill("SIGKILL"), 2_000);
  }, timeoutMs);
  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).finally(() => {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
  });
  const result = { argv, exitCode: timedOut ? 124 : exitCode, stdout, stderr, timedOut };
  if (result.exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await run(["which", command], { allowFailure: true, timeoutMs: 2_000 })).exitCode === 0;
}
