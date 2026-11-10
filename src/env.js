// Persist a secret-ish value into the user's *system* environment, then expose it to
// this process so an MCP server mounted right now resolves its `${VAR}` placeholder.
import { spawnSync } from "node:child_process";

function quotePowerShell(value) {
  return String(value).replace(/'/g, "''");
}

/**
 * Write one user-level environment variable.
 * Windows: [Environment]::SetEnvironmentVariable(name, value, 'User') — the same store
 * the "环境变量" dialog edits, so it survives restarts and is inherited by new processes.
 */
export function setUserEnvironmentVariable(name, value) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`非法的环境变量名：${name}`);
  if (typeof value !== "string" || value === "") throw new Error("值不能为空");

  if (process.platform === "win32") {
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `[Environment]::SetEnvironmentVariable('${quotePowerShell(name)}','${quotePowerShell(value)}','User')`,
      ],
      { windowsHide: true, encoding: "utf8", timeout: 20000 },
    );
    if (result.status !== 0) {
      throw new Error(`写入系统环境变量失败：${(result.stderr || result.stdout || "").trim() || `exit ${result.status}`}`);
    }
  } else {
    const result = spawnSync("sh", ["-c", `echo 'export ${name}="${String(value).replace(/"/g, '\\"')}"' >> ~/.profile`], {
      encoding: "utf8",
      timeout: 10000,
    });
    if (result.status !== 0) throw new Error(`写入 shell 配置失败：${(result.stderr || "").trim()}`);
  }

  process.env[name] = value;
  return { ok: true, name, scope: "user", platform: process.platform };
}

export function readEnvironmentVariable(name) {
  return process.env[name] || "";
}
