import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";

const root = path.resolve(import.meta.dirname, "..");
const artifacts = path.join(root, "src-tauri/target/downloader-browser");
await mkdir(artifacts, { recursive: true });
const bundle = await build({
  absWorkingDir: root, entryPoints: ["tests/downloader-harness.tsx"],
  bundle: true, write: false, outdir: artifacts, jsx: "automatic",
  loader: { ".png": "dataurl" }, define: { "process.env.NODE_ENV": '"development"' }
});
const assets = new Map(bundle.outputFiles.map((file) => [path.basename(file.path), file.contents]));
const html = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/downloader-harness.css"><style>html,body,#root{height:100%;margin:0}#root{padding:24px;box-sizing:border-box}.downloaderView{height:100%}</style></head><body><div id="root"></div><script src="/downloader-harness.js"></script></body></html>`;
const server = createServer((req, res) => {
  const name = req.url.slice(1);
  res.setHeader("Content-Type", name.endsWith(".js") ? "text/javascript" : name.endsWith(".css") ? "text/css" : "text/html");
  res.end(assets.get(name) ?? html);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const profile = path.join(artifacts, `profile-${Date.now()}`);
const executable = process.env.DOWNLOADER_TEST_BROWSER || "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const child = spawn(executable, ["--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "about:blank"], { windowsHide: true, stdio: "ignore" });
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let socket;
const errors = [];
try {
  let port;
  for (let attempt = 0; attempt < 150; attempt++) {
    try { port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0]; break; }
    catch { await delay(100); }
  }
  assert.ok(port, "Browser must expose a debugging port");
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  socket = new WebSocket(targets.find((target) => target.type === "page").webSocketDebuggerUrl);
  await once(socket, "open");
  let id = 0;
  const pending = new Map();
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === "Runtime.exceptionThrown") errors.push(message.params.exceptionDetails.text);
    if (pending.has(message.id)) {
      const { resolve, reject, timer } = pending.get(message.id);
      clearTimeout(timer); pending.delete(message.id);
      message.error ? reject(new Error(message.error.message)) : resolve(message.result);
    }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const messageId = ++id;
    const timer = setTimeout(() => reject(new Error(`Timed out: ${method}`)), 15000);
    pending.set(messageId, { resolve, reject, timer });
    socket.send(JSON.stringify({ id: messageId, method, params }));
  });
  const evaluate = async (expression) => {
    const response = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || expression);
    return response.result.value;
  };
  const until = async (expression) => {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (await evaluate(expression)) return;
      await delay(50);
    }
    throw new Error(`Condition did not become true: ${expression}`);
  };
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const input = (selector, value) => evaluate(`(() => { const field = document.querySelector(${JSON.stringify(selector)}); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(field, ${JSON.stringify(value)}); field.dispatchEvent(new Event('input', {bubbles:true})); })()`);
  const screenshot = async (name) => {
    await delay(300); // Let theme and control transitions settle before capture.
    const shot = await send("Page.captureScreenshot", { format: "png" });
    await writeFile(path.join(artifacts, name), Buffer.from(shot.data, "base64"));
  };
  await send("Runtime.enable");
  await send("Page.enable");
  await send("Emulation.setDeviceMetricsOverride", { width: 1100, height: 1100, deviceScaleFactor: 1, mobile: false });
  await send("Page.navigate", { url: `http://127.0.0.1:${server.address().port}` });
  await until("!!document.querySelector('.downloadUrlField input')");
  await input(".downloadUrlField input", "https://example.com/audio");
  await until("document.querySelector('#web-source-tab').getAttribute('aria-selected') === 'true'");
  await click("input[value='mp3']");
  await input(".pathPicker input", "C:\\My Music");
  await screenshot("downloader-desktop.png");
  await click("button[type='submit']");
  await until("downloaderTest.calls.length === 1");
  assert.equal(await evaluate("downloaderTest.calls[0].format"), "mp3");
  assert.equal(await evaluate("downloaderTest.calls[0].destinationDir"), "C:\\My Music");
  // The event arrives before the invoke promise. The form must remain locked.
  await evaluate("downloaderTest.emit('download://completed', downloaderTest.result())");
  await delay(100);
  assert.equal(await evaluate("document.querySelector('button[type=submit]').disabled"), true);
  await evaluate("downloaderTest.rejectStatus = true; downloaderTest.finish(downloaderTest.result())");
  await until("!!document.querySelector('.downloadResult')");
  assert.equal(await evaluate("!!document.querySelector('[role=alert]')"), false, "Health failures cannot turn success into failure");
  await click(".downloadedFiles button");
  await until("document.querySelector('[role=alert]')?.textContent.includes('Explorer unavailable')");
  assert.equal(await evaluate("!!document.querySelector('.downloadResult')"), true);
  await input(".downloadUrlField input", "https://open.spotify.com/album/12345");
  await until("document.querySelector('#spotify-source-tab').getAttribute('aria-selected') === 'true'");
  assert.match(await evaluate("document.querySelector('button[type=submit]').textContent"), /album/);
  await click(".downloaderTools summary");
  await click(".downloaderRepairButton");
  await until("document.querySelector('.dangerAction')?.textContent.includes('Cancel repair')");
  await click(".dangerAction");
  await until("downloaderTest.cancelCalls === 1");
  await evaluate("downloaderTest.finishRepair()");
  await until("!document.querySelector('.dangerAction')");
  assert.equal(await evaluate("document.querySelector('#spotify-source-tab').disabled"), false);
  await click(".downloaderRepairButton");
  await until("!!document.querySelector('.dangerAction')");
  assert.equal(await evaluate("document.querySelector('.dangerAction').disabled"), false, "A previous cancellation must not disable cancel on the next repair");
  await evaluate("downloaderTest.finishRepair()");
  await until("!document.querySelector('.dangerAction')");
  await click(".downloaderTools summary");
  await send("Emulation.setDeviceMetricsOverride", { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await screenshot("downloader-mobile.png");
  assert.equal(await evaluate("document.querySelector('.downloaderView').scrollWidth <= document.querySelector('.downloaderView').clientWidth"), true);
  await evaluate("document.documentElement.dataset.theme = 'light'");
  await screenshot("downloader-light.png");
  await send("Page.reload");
  await until("!!document.querySelector('.pathPicker input')");
  assert.equal(await evaluate("document.querySelector('.pathPicker input').value"), "C:\\My Music");
  assert.equal(await evaluate("document.querySelector('input[value=mp3]').checked"), true);
  await click(".pathPicker button");
  await until("document.querySelector('[role=alert]')?.textContent.includes('Picker unavailable')");
  assert.deepEqual(errors, [], "No unhandled browser errors");
  console.log("Downloader browser checks passed: request settings, auto-detection, event/promise ordering, status failure, file actions, repair cancellation, persistence, and responsive layout.");
  console.log(`Screenshots: ${artifacts}`);
  await send("Browser.close");
} finally {
  socket?.close();
  child.kill();
  server.close();
}
