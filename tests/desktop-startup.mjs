import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

// Release WebViews may disable CDP. Verify the native window with Windows UIA.
const root = path.resolve(import.meta.dirname, "..");
const script = await readFile(path.join(root, "tests/desktop-startup.ps1"), "utf8");
const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
  cwd: root, windowsHide: true, stdio: "inherit"
});
child.on("error", (error) => { console.error(error); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
