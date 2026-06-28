import type { RunResult } from "./types";

export class CommandError extends Error {
  constructor(public readonly result: RunResult) {
    super(`Command failed (${result.exitCode}): ${result.argv.join(" ")}\n${result.stderr || result.stdout}`);
  }
}

export interface ProcessControl {
  endStdin(): void;
  terminate(exitCode?: number): void;
}

export async function run(argv: string[], options: {
  timeoutMs?: number;
  input?: string;
  allowFailure?: boolean;
  env?: Record<string, string>;
  interactive?: boolean;
  keepStdinOpen?: boolean;
  onStdout?: (text: string, writeStdin: (chunk: string) => void, control: ProcessControl) => void;
} = {}): Promise<RunResult> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const env = { ...Bun.env, ...options.env };
  if (env.DBUS_SESSION_BUS_ADDRESS === undefined && typeof process.getuid === "function") {
    const uid = process.getuid();
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=/run/user/${uid}/bus`;
  }

  const child = Bun.spawn(argv, {
    stdin: options.interactive || options.input !== undefined || options.onStdout !== undefined ? "pipe" : "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env,
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
    if (!options.keepStdinOpen) {
      child.stdin.end();
    }
  }

  let stdoutText = "";
  let stderrText = "";
  let readPromise = Promise.resolve();
  let timedOut = false;
  let requestedExitCode: number | undefined;
  let forceTimer: ReturnType<typeof setTimeout> | undefined;

  const control: ProcessControl = {
    endStdin() {
      try { child.stdin?.end(); } catch {}
    },
    terminate(exitCode?: number) {
      if (exitCode !== undefined) requestedExitCode = exitCode;
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        forceTimer ??= setTimeout(() => child.kill("SIGKILL"), 2_000);
      }
    },
  };

  const readStream = async (stream: ReadableStream<Uint8Array>, isStdout: boolean) => {
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { value, done } = await reader.read();
      const text = done ? decoder.decode() : decoder.decode(value, { stream: true });
      if (done) {
        if (!text) break;
      }
      if (isStdout) {
        stdoutText += text;
        if (options.interactive) {
          if (value) globalThis.process.stdout.write(value);
          else globalThis.process.stdout.write(text);
        }
        const stdin = child.stdin;
        if (options.onStdout && stdin) {
          options.onStdout(text, (chunk) => stdin.write(chunk), control);
        }
      } else {
        stderrText += text;
        if (options.interactive) {
          if (value) globalThis.process.stderr.write(value);
          else globalThis.process.stderr.write(text);
        }
      }
      if (done) break;
    }
  };

  readPromise = Promise.all([
    readStream(child.stdout, true),
    readStream(child.stderr, false)
  ]).then(() => {});

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
  const result = { argv, exitCode: timedOut ? 124 : requestedExitCode ?? exitCode, stdout, stderr, timedOut };
  if (result.exitCode !== 0 && !options.allowFailure) throw new CommandError(result);
  return result;
}

export async function commandExists(command: string): Promise<boolean> {
  return (await run(["which", command], { allowFailure: true, timeoutMs: 2_000 })).exitCode === 0;
}
