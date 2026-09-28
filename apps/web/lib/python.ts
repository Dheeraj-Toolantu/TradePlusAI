import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

/** Run a tradepulse_quant module that reads JSON on stdin and writes JSON on stdout. */
export function runPythonModule<T>(module: string, payload: unknown, timeoutMs = 15_000): Promise<T> {
  const root = existsSync(path.resolve(process.cwd(), "quant")) ? process.cwd() : path.resolve(process.cwd(), "../..");
  const executable = process.env.PYTHON_EXECUTABLE ?? "python";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["-m", module], { cwd: root, env: { ...process.env, PYTHONPATH: path.join(root, "quant", "src") }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) { reject(new Error(stderr.trim().split("\n").at(-1) || `${module} exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout) as T); } catch { reject(new Error(`${module} returned invalid JSON`)); }
    });
    child.stdin.end(JSON.stringify(payload));
  });
}
