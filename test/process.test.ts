import { describe, expect, test } from "bun:test";
import { run } from "../src/process";

const hangingChild = [
  process.execPath,
  "--eval",
  "console.log('ready'); setInterval(() => {}, 1000);",
];

describe("process runner control", () => {
  test("does not report requested termination as success by default", async () => {
    const result = await run(hangingChild, {
      allowFailure: true,
      timeoutMs: 5_000,
      onStdout: (text, _writeStdin, control) => {
        if (text.includes("ready")) control.terminate();
      },
    });

    expect(result.stdout).toContain("ready");
    expect(result.exitCode).not.toBe(0);
    expect(result.timedOut).toBeFalse();
  });

  test("allows callers to mark an intentional termination as success", async () => {
    const result = await run(hangingChild, {
      allowFailure: true,
      timeoutMs: 5_000,
      onStdout: (text, _writeStdin, control) => {
        if (text.includes("ready")) control.terminate(0);
      },
    });

    expect(result.stdout).toContain("ready");
    expect(result.exitCode).toBe(0);
    expect(result.timedOut).toBeFalse();
  });
});
