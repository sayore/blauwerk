import { Bluez } from "./bluez";
import { DeviceRegistry } from "./registry";
import { log } from "./log";
import { existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { run } from "./process";

export async function runDaemon(intervalSeconds = 300, scanSeconds = 30): Promise<void> {
  const bluez = new Bluez();
  const registry = new DeviceRegistry();
  log("daemon.start", { intervalSeconds, scanSeconds });

  let running = true;
  const shutdown = () => {
    log("daemon.stop", {});
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  while (running) {
    try {
      log("daemon.scan.start", {});
      const controller = new AbortController();
      
      const scanPromise = bluez.scanLive("on", scanSeconds, {
        signal: controller.signal,
        onDevice: (device) => {
          registry.record(device);
        },
      });

      const checkShutdown = setInterval(() => {
        if (!running) {
          controller.abort();
          clearInterval(checkShutdown);
        }
      }, 500);

      await scanPromise.catch(err => {
        // Only log if it wasn't a clean abort on shutdown
        if (running) log("daemon.scan.error", { error: String(err) });
      });
      
      clearInterval(checkShutdown);
      log("daemon.scan.complete", { totalDevices: registry.list().length });
    } catch (e) {
      log("daemon.error", { error: String(e) });
    }

    // Sleep for the configured interval, checking running state for responsive shutdown
    const sleepEnd = Date.now() + intervalSeconds * 1000;
    while (running && Date.now() < sleepEnd) {
      await Bun.sleep(1000);
    }
  }
}

export async function installDaemon(intervalSeconds = 300, scanSeconds = 30, homeDir?: string): Promise<void> {
  const home = homeDir || homedir() || process.env.HOME;
  if (!home) throw new Error("Could not resolve home directory");
  
  const serviceDir = join(home, ".config", "systemd", "user");
  mkdirSync(serviceDir, { recursive: true });
  
  const exe = Bun.argv[0];
  const script = Bun.argv[1];
  let execStart = `${exe} daemon --run --interval ${intervalSeconds} --seconds ${scanSeconds}`;
  if (script && (script.endsWith(".ts") || script.endsWith(".js"))) {
    execStart = `${exe} run ${script} daemon --run --interval ${intervalSeconds} --seconds ${scanSeconds}`;
  }
  
  const serviceContent = `[Unit]
Description=Blauwerk Passive Bluetooth Scanner Daemon
After=bluetooth.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=always
RestartSec=15
Environment=PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

[Install]
WantedBy=default.target
`;

  const servicePath = join(serviceDir, "blauwerk-scanner.service");
  writeFileSync(servicePath, serviceContent, { encoding: "utf8", mode: 0o644 });
  console.log(`Systemd user service written to: ${servicePath}`);
  
  const reload = await run(["systemctl", "--user", "daemon-reload"], { allowFailure: true });
  if (reload.exitCode !== 0) {
    throw new Error(`Failed to reload systemd user daemon: ${reload.stderr || reload.stdout}`);
  }
  console.log("Systemd user daemon reloaded successfully.");
}

export async function startDaemon(): Promise<void> {
  const result = await run(["systemctl", "--user", "enable", "--now", "blauwerk-scanner"], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to enable/start daemon service: ${result.stderr || result.stdout}`);
  }
  console.log("Blauwerk background scanner daemon enabled and started successfully.");
}

export async function stopDaemon(): Promise<void> {
  const result = await run(["systemctl", "--user", "disable", "--now", "blauwerk-scanner"], { allowFailure: true });
  if (result.exitCode !== 0) {
    throw new Error(`Failed to disable/stop daemon service: ${result.stderr || result.stdout}`);
  }
  console.log("Blauwerk background scanner daemon stopped and disabled successfully.");
}

export async function getDaemonStatus(): Promise<string> {
  const result = await run(["systemctl", "--user", "status", "blauwerk-scanner"], { allowFailure: true });
  return `${result.stdout}\n${result.stderr}`.trim();
}
