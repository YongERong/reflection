import { spawn } from "node:child_process";

const processes = [
  {
    name: "bot",
    command: "npm",
    args: ["run", "dev:bot"]
  },
  {
    name: "polling",
    command: "npm",
    args: ["run", "dev:bot:polling"]
  },
  {
    name: "tunnel",
    command: "cloudflared",
    args: ["tunnel", "--config", `${process.env.HOME}/.cloudflared/reflection.yaml`, "run", "reflection"]
  }
];

const children = new Map();
let shuttingDown = false;

for (const processConfig of processes) {
  start(processConfig);
}

process.once("SIGINT", () => shutdown("SIGINT"));
process.once("SIGTERM", () => shutdown("SIGTERM"));

function start(processConfig) {
  const child = spawn(processConfig.command, processConfig.args, {
    stdio: "inherit",
    env: process.env
  });

  children.set(processConfig.name, child);

  child.on("exit", (code, signal) => {
    children.delete(processConfig.name);
    if (shuttingDown) return;
    const reason = signal ? `signal ${signal}` : `exit code ${code}`;
    console.error(`[dev:local] ${processConfig.name} stopped with ${reason}. Stopping dev environment.`);
    shutdown("child-exit");
  });

  child.on("error", (error) => {
    children.delete(processConfig.name);
    if (shuttingDown) return;
    console.error(`[dev:local] Failed to start ${processConfig.name}:`, error);
    shutdown("child-error");
  });
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[dev:local] Shutting down (${reason})...`);

  for (const child of children.values()) {
    if (!child.killed) child.kill("SIGTERM");
  }

  setTimeout(() => {
    for (const child of children.values()) {
      if (!child.killed) child.kill("SIGKILL");
    }
    process.exit(reason === "SIGINT" || reason === "SIGTERM" ? 0 : 1);
  }, 3000).unref();
}
