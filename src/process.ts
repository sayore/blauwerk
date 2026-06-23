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
  interactive?: boolean;
} = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = Bun.spawn(argv, {
    stdin: options.interactive || options.input !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: { ...Bun.env, ...options.env },
  });

  let onData: ((chunk: any) => void) | undefined;
  if (options.input !== undefined && child.stdin) {
    child.stdin.write(options.input);
  }

  if (options.interactive && child.stdin) {
    globalThis.process.stdin.resume();
    const stdinSink = child.stdin;
    onData = (chunk) => {
      stdinSink.write(chunk);
    };
    globalThis.process.stdin.on("data", onData);
  } else if (options.input !== undefined && child.stdin) {
    child.stdin.end();
  }

  let stdoutText = "";
  let stderrText = "";
  let readPromise = Promise.resolve();

  const readStream = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      if (isStdout) {
        stdoutText += text;
        if (options.interactive) globalThis.process.stdout.write(value);
      } else {
        stderrText += text;
        if (options.interactive) globalThis.process.stderr.write(value);
      }
    }
  };

  readPromise = Promise.all([
    readStream(child.stdout, true),
    readStream(child.stderr, false)
  ]).then(() => {});

  let timedOut = false;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    forceTimer = setTimeout(() => child.kill("SIGKILL"), 2_000);
  }, timeoutMs);

  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    readPromise.then(() => stdoutText),
    readPromise.then(() => stderrText),
  ]).finally(() => {
    clearTimeout(timer);
    if (forceTimer) clearTimeout(forceTimer);
    if (options.interactive) {
      if (onData) {
        globalThis.process.stdin.removeListener("data", onData);
      }
      globalThis.process.stdin.pause();
    }
  });
  const result = { argv, exitCode: timedOut ? 124 : exitCode, stdout, stderr, timedOut };
  if (result.exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await run(["which", command], { allowFailure: true, timeoutMs: 2_000 })).exitCode === 0;
}
