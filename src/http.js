// curl transport for upstreams whose edge fingerprints the TLS client.
//
// skillsmp.com sits behind Cloudflare: with a full browser header set, python urllib
// and curl get 200 + JSON, while this process's own `fetch` (undici) and `node:https`
// both get 403 "Just a moment…". The difference is the TLS/ALPN fingerprint, not the
// headers, so no header tweak can fix it from inside Node. Shelling out to the curl
// that ships with Windows 10+, macOS and Linux is the transport that survives, and it
// is the same one the reference implementation ends up using (urllib's stack).
//
// Usage is deliberately tiny: one text getter and one JSON getter.
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

const CURL_BINARIES = ["curl.exe", "curl"];

/** Headers that made the Cloudflare-fronted endpoints answer 200. */
export const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  accept: "application/json, text/plain, */*",
  "accept-language": "en-US,en;q=0.9",
};

function runCurl(binary, url, headers, timeoutMs) {
  const args = ["-s", "-S", "--compressed", "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000)))];
  for (const [name, value] of Object.entries(headers)) args.push("-H", `${name}: ${value}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    execFile(
      binary,
      args,
      { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs + 5000, windowsHide: true },
      (error, stdout) => {
        if (error) reject(error);
        else resolve(String(stdout || ""));
      },
    );
  });
}

/** GET a URL through curl with the browser header set; returns the response body. */
export async function curlText(url, { headers = {}, timeoutMs = 15000 } = {}) {
  const merged = { ...BROWSER_HEADERS, ...headers };
  let lastError;
  for (const binary of CURL_BINARIES) {
    try {
      return await runCurl(binary, url, merged, timeoutMs);
    } catch (error) {
      lastError = error;
      // A missing binary means "try the next candidate name"; anything else is real.
      if (error && error.code === "ENOENT") continue;
      throw new Error(`curl 请求失败：${url} → ${String((error && error.message) || error).slice(0, 160)}`);
    }
  }
  throw new Error(`系统里没有可用的 curl，无法绕过后端的 TLS 指纹拦截：${String((lastError && lastError.message) || lastError)}`);
}

/** GET + parse JSON through curl; a challenge page (HTML) is reported as such. */
export async function curlJson(url, options) {
  const text = await curlText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`上游返回的不是 JSON（多半是反爬挑战页）：${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
}

/**
 * JSON GET for ordinary APIs: try this process's own fetch first (fast, no child process),
 * then fall back to curl for edges that refuse Node's TLS fingerprint. Pass
 * `viaCurlFirst` for hosts already known to reject Node.
 */
export async function getJson(url, { headers = {}, timeoutMs = 20000, viaCurlFirst = false } = {}) {
  if (viaCurlFirst) return curlJson(url, { headers, timeoutMs });
  let fetchError;
  try {
    const response = await fetch(url, {
      headers: { ...BROWSER_HEADERS, ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
    return await response.json();
  } catch (error) {
    fetchError = error;
  }
  try {
    return await curlJson(url, { headers, timeoutMs });
  } catch {
    throw fetchError;
  }
}

// ------------------------------------------------------------------ python transport
// skillsmp.com sits behind Cloudflare's managed challenge, which fingerprints the TLS and
// HTTP/2 stack rather than the headers. Measured from the same machine and the same
// headers: Node fetch → 403, node:https → 403, Windows curl 8.22 (Schannel) → 403, and
// CPython's urllib (OpenSSL) → 200. The reference implementation passes for exactly that
// reason, so the Python interpreter DSH already ships is used as the transport.
const PY_CANDIDATES = ["python", "python3", "py"];

const PY_FETCH = [
  "import sys, json, urllib.request",
  "url, headers, timeout = sys.argv[1], json.loads(sys.argv[2]), float(sys.argv[3])",
  "request = urllib.request.Request(url, headers=headers)",
  "with urllib.request.urlopen(request, timeout=timeout) as response:",
  "    sys.stdout.write(response.read().decode('utf-8', 'replace'))",
].join("\n");

const PY_POST = [
  "import sys, json, urllib.request",
  "url, body, headers, timeout = sys.argv[1], sys.argv[2], json.loads(sys.argv[3]), float(sys.argv[4])",
  "request = urllib.request.Request(url, data=body.encode('utf-8'), headers=headers, method='POST')",
  "with urllib.request.urlopen(request, timeout=timeout) as response:",
  "    sys.stdout.write(response.read().decode('utf-8', 'replace'))",
].join("\n");

async function isPython(binary) {
  // A relocatable CPython can be present but unusable (its stdlib may be pinned to the
  // build machine, e.g. "AssertionError: SRE module mismatch"), so the probe imports what
  // the transport actually needs instead of trusting the executable's presence.
  const probe = "import json, ssl, urllib.request; print(1)";
  return new Promise((resolve) => {
    execFile(binary, ["-c", probe], { timeout: 8000, windowsHide: true }, (error, stdout) => {
      resolve(!error && String(stdout).trim() === "1");
    });
  });
}

/** Locate an interpreter once: bundled DSH runtime first, then PATH names. */
let pythonPromise = null;
function findPython() {
  if (pythonPromise) return pythonPromise;
  pythonPromise = (async () => {
    const home = process.env.USERPROFILE || process.env.HOME || "";
    const candidates = [];
    if (process.env.DSH_PYTHON) candidates.push(process.env.DSH_PYTHON);
    if (home) {
      const runtimes = join(home, ".dsh", "dsh-runtimes");
      try {
        for (const entry of await readdir(runtimes, { withFileTypes: true })) {
          if (!entry.isDirectory()) continue;
          candidates.push(join(runtimes, entry.name, "dependencies", "python", "python.exe"));
        }
      } catch {
        // no bundled runtime on this machine
      }
    }
    candidates.push(...PY_CANDIDATES);
    for (const candidate of candidates) {
      // eslint-disable-next-line no-await-in-loop
      if (await isPython(candidate)) return candidate;
    }
    return "";
  })();
  return pythonPromise;
}

export async function pythonText(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const python = await findPython();
  if (!python) throw new Error("没有可用的 Python 解释器，无法通过该传输取数");
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ["-c", PY_FETCH, url, JSON.stringify({ ...BROWSER_HEADERS, ...headers }), String(timeoutMs / 1000)],
      {
        timeout: timeoutMs + 5000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`python 取数失败：${String(stderr || error.message).slice(0, 200)}`));
        else resolve(String(stdout));
      },
    );
  });
}

const PY_DOWNLOAD = [
  "import sys, urllib.request",
  "url, target, timeout = sys.argv[1], sys.argv[2], float(sys.argv[3])",
  "request = urllib.request.Request(url, headers={'User-Agent': 'dsh-market/0.1 (+skill installer)'})",
  "with urllib.request.urlopen(request, timeout=timeout) as response, open(target, 'wb') as handle:",
  "    while True:",
  "        chunk = response.read(1 << 20)",
  "        if not chunk: break",
  "        handle.write(chunk)",
  "print('ok')",
].join("\n");

/** Stream a URL to a file through the Python transport (used for repository tarballs). */
export async function pythonDownload(url, target, { timeoutMs = 120000 } = {}) {
  const python = await findPython();
  if (!python) throw new Error("没有可用的 Python 解释器，无法下载归档");
  await new Promise((resolve, reject) => {
    execFile(
      python,
      ["-c", PY_DOWNLOAD, url, target, String(timeoutMs / 1000)],
      { timeout: timeoutMs + 10000, windowsHide: true, env: { ...process.env, PYTHONUTF8: "1" } },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`归档下载失败：${String(stderr || error.message).slice(0, 200)}`));
        else resolve(String(stdout));
      },
    );
  });
  return target;
}

export async function pythonJson(url, options = {}) {
  const text = await pythonText(url, options);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`上游返回的不是 JSON（可能被反爬挑战页拦截）：${text.slice(0, 80).replace(/\s+/g, " ")}`);
  }
}

/**
 * Transport escalation for hosts that challenge automation: python (the stack that passes
 * the managed challenge) → curl → Node fetch. Every layer is a real request; the first one
 * that yields JSON wins, and the last error is reported when all fail.
 */
export async function getJsonEscalating(url, { headers = {}, timeoutMs = 20000 } = {}) {
  const attempts = [
    () => pythonJson(url, { headers, timeoutMs }),
    () => curlJson(url, { headers, timeoutMs }),
    () => getJson(url, { headers, timeoutMs }),
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await attempt();
    } catch (error) {
      errors.push(String((error && error.message) || error).slice(0, 120));
    }
  }
  throw new Error(errors[0] || "所有传输方式都失败");
}

/** POST a JSON body through curl (some hosts only answer a non-Node TLS client). */
export async function curlPostText(url, body, { headers = {}, timeoutMs = 15000 } = {}) {
  const merged = { ...BROWSER_HEADERS, "content-type": "application/json", ...headers };
  const payload = JSON.stringify(body ?? {});
  const args = [
    "-s", "-S", "--compressed",
    "--max-time", String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    "-X", "POST",
    "--data-binary", "@-",
  ];
  for (const [name, value] of Object.entries(merged)) args.push("-H", `${name}: ${value}`);
  args.push(url);
  return new Promise((resolve, reject) => {
    const child = execFile("curl.exe", args, { maxBuffer: 16 * 1024 * 1024, timeout: timeoutMs + 5000, windowsHide: true },
      (error, stdout) => (error ? reject(error) : resolve(String(stdout || ""))));
    if (child.stdin) {
      child.stdin.end(payload);
    }
  });
}

/** POST a JSON body through the Python transport. */
export async function pythonPostText(url, body, { headers = {}, timeoutMs = 20000 } = {}) {
  const python = await findPython();
  if (!python) throw new Error("没有可用的 Python 解释器，无法通过该传输取数");
  return new Promise((resolve, reject) => {
    execFile(
      python,
      ["-c", PY_POST, url, JSON.stringify(body ?? {}), JSON.stringify({ ...BROWSER_HEADERS, "content-type": "application/json", ...headers }), String(timeoutMs / 1000)],
      {
        timeout: timeoutMs + 5000,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, PYTHONIOENCODING: "utf-8", PYTHONUTF8: "1" },
      },
      (error, stdout, stderr) => {
        if (error) reject(new Error(`python POST 失败：${String(stderr || error.message).slice(0, 200)}`));
        else resolve(String(stdout));
      },
    );
  });
}

/**
 * POST escalation for hosts whose edge drops this process's TLS handshake: python → curl →
 * Node fetch, first JSON response wins.
 */
export async function postJsonEscalating(url, body, { headers = {}, timeoutMs = 20000 } = {}) {
  const parse = (text) => {
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`上游返回的不是 JSON：${String(text).slice(0, 80).replace(/\s+/g, " ")}`);
    }
  };
  const attempts = [
    async () => parse(await pythonPostText(url, body, { headers, timeoutMs })),
    async () => parse(await curlPostText(url, body, { headers, timeoutMs })),
    async () => {
      const response = await fetch(url, {
        method: "POST",
        headers: { ...BROWSER_HEADERS, "content-type": "application/json", ...headers },
        body: JSON.stringify(body ?? {}),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
      return response.json();
    },
  ];
  const errors = [];
  for (const attempt of attempts) {
    try {
      // eslint-disable-next-line no-await-in-loop
      return await attempt();
    } catch (error) {
      errors.push(String((error && error.message) || error).slice(0, 120));
    }
  }
  throw new Error(errors[0] || "所有传输方式都失败");
}
