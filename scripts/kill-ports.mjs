import { execFileSync } from "node:child_process";

const DEFAULT_PORTS = [
  8766, // brain
  8790, // asset-gen
  // vite (usually 5173, but may auto-bump if busy)
  5173, 5174, 5175, 5176, 5177, 5178, 5179, 5180
];

const ports = process.argv.slice(2).length
  ? process.argv.slice(2).map((p) => Number(p)).filter((n) => Number.isFinite(n))
  : DEFAULT_PORTS;

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    const stdout = e?.stdout?.toString?.() ?? "";
    const stderr = e?.stderr?.toString?.() ?? "";
    return `${stdout}\n${stderr}`.trim();
  }
}

function killPid(pid) {
  if (!pid) return false;
  if (process.platform === "win32") {
    run("taskkill", ["/PID", String(pid), "/F", "/T"]);
    return true;
  }
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function killPortWin32(port) {
  const out = run("netstat", ["-ano", "-p", "tcp"]);
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    // Proto Local Address           Foreign Address         State           PID
    // TCP    127.0.0.1:8766         0.0.0.0:0               LISTENING       1234
    if (!line.includes("LISTENING")) continue;
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const local = parts[1];
    const pid = Number(parts[4]);
    if (!local?.endsWith(`:${port}`)) continue;
    if (Number.isFinite(pid)) pids.add(pid);
  }
  let killed = 0;
  for (const pid of pids) if (killPid(pid)) killed++;
  return { pids: [...pids], killed };
}

function killPortPosix(port) {
  const out = run("lsof", ["-ti", `tcp:${port}`]);
  const pids = out
    .split(/\r?\n/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n));
  let killed = 0;
  for (const pid of pids) if (killPid(pid)) killed++;
  return { pids, killed };
}

let totalKilled = 0;
for (const port of ports) {
  const res =
    process.platform === "win32" ? killPortWin32(port) : killPortPosix(port);
  if (res.killed > 0) {
    totalKilled += res.killed;
    // eslint-disable-next-line no-console
    console.log(`[kill:ports] port ${port}: killed PID(s) ${res.pids.join(", ")}`);
  }
}

if (totalKilled === 0) {
  // eslint-disable-next-line no-console
  console.log(`[kill:ports] no listeners found on: ${ports.join(", ")}`);
}

