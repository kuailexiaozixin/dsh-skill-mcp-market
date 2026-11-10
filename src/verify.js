// Install-time safety scan: quarantine contents are inspected before they are moved
// into a watched skill directory. Mirrors the reference implementation's
// quarantine → scan → install pipeline, adapted to a plain <name>/SKILL.md bundle.

const TEXT_EXT = /\.(md|markdown|txt|json|ya?ml|js|mjs|cjs|ts|tsx|jsx|py|sh|bash|zsh|ps1|psm1|rb|go|rs|java|kt|toml|ini|cfg|html?|css|scss|sql|xml|csv)$/i;

const RULES = [
  { id: "pipe-to-shell", severity: "high", re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, why: "下载内容直接管道给 shell 执行" },
  { id: "pipe-to-powershell", severity: "high", re: /\b(iwr|invoke-webrequest|curl)\b[^\n|]*\|\s*(iex|invoke-expression)\b/i, why: "下载内容直接交给 PowerShell 执行" },
  { id: "powershell-encoded", severity: "high", re: /powershell(\.exe)?[^\n]{0,40}-e(nc|ncodedcommand)?\s+[A-Za-z0-9+/=]{40,}/i, why: "PowerShell 编码命令（常用于绕过检测）" },
  { id: "eval-invoke", severity: "medium", re: /\b(eval|exec)\s*\(\s*(base64|atob|Buffer\.from)/i, why: "对解码后的内容执行 eval/exec" },
  { id: "ssh-write", severity: "high", re: /(>>?|set-content|add-content)[^\n]{0,80}(\.ssh[\\/](id_|authorized_keys|config)|\.aws[\\/]credentials)/i, why: "改写 SSH / 云凭证文件" },
  { id: "destructive-rm", severity: "high", re: /\brm\s+-rf\s+(\/|\$HOME|~|C:\\\\?)|Remove-Item[^\n]{0,60}-Recurse[^\n]{0,40}(C:\\\\?|~)/i, why: "递归删除根目录或用户目录" },
  { id: "secret-exfil", severity: "high", re: /\b(curl|wget|Invoke-RestMethod|fetch)\b[^\n]{0,120}(process\.env|GITHUB_TOKEN|OPENAI_API_KEY|AWS_SECRET|\.env\b)/i, why: "把环境变量/密钥外发" },
  { id: "chmod-777", severity: "low", re: /chmod\s+777/i, why: "放宽文件权限到 777" },
  { id: "base64-blob", severity: "low", re: /[A-Za-z0-9+/]{600,}={0,2}/, why: "超长 base64 片段（可能是编码载荷）" },
];

const LIMITS = { maxFiles: 400, maxFileBytes: 2 * 1024 * 1024, maxTotalBytes: 20 * 1024 * 1024 };

/**
 * Inspect a staged skill bundle.
 * @param {{ files: Record<string,string>, skillText: string }} bundle
 * @returns {{ allowed: boolean, findings: object[], stats: object }}
 */
export function scanSkillBundle({ files, skillText }) {
  const findings = [];
  const names = Object.keys(files || {});
  let totalBytes = 0;

  if (names.length > LIMITS.maxFiles) {
    findings.push({ rule: "too-many-files", severity: "high", file: "", why: `文件数 ${names.length} 超过 ${LIMITS.maxFiles}` });
  }

  for (const name of names) {
    if (name.includes("..") || name.startsWith("/") || /^[A-Za-z]:/.test(name)) {
      findings.push({ rule: "path-escape", severity: "high", file: name, why: "路径越界或绝对路径" });
      continue;
    }
    const content = String(files[name] ?? "");
    const bytes = Buffer.byteLength(content, "utf8");
    totalBytes += bytes;
    if (bytes > LIMITS.maxFileBytes) {
      findings.push({ rule: "file-too-large", severity: "medium", file: name, why: `${bytes} 字节超过 ${LIMITS.maxFileBytes}` });
    }
    if (!TEXT_EXT.test(name)) {
      findings.push({ rule: "binary-resource", severity: "low", file: name, why: "非文本资源，请人工确认用途" });
      continue;
    }
    for (const rule of RULES) {
      if (rule.re.test(content)) {
        findings.push({ rule: rule.id, severity: rule.severity, file: name, why: rule.why });
      }
    }
  }

  if (totalBytes > LIMITS.maxTotalBytes) {
    findings.push({ rule: "bundle-too-large", severity: "high", file: "", why: `总体积 ${totalBytes} 字节超过 ${LIMITS.maxTotalBytes}` });
  }
  if (!String(skillText || "").includes("---")) {
    findings.push({ rule: "missing-frontmatter", severity: "high", file: "SKILL.md", why: "缺少 YAML frontmatter" });
  }

  const high = findings.filter((f) => f.severity === "high");
  return {
    allowed: high.length === 0,
    findings,
    stats: { files: names.length, totalBytes, high: high.length },
  };
}

export function describeFindings(findings) {
  return findings
    .map((f) => `[${f.severity}] ${f.rule}${f.file ? ` @ ${f.file}` : ""} — ${f.why}`)
    .join("; ");
}
