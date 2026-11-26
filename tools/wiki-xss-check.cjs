// Stored-XSS check of the wiki pages and dialogs (Playwright): node tools/wiki-xss-check.cjs
// Creates content with an HTML/JS payload everywhere a person can type, opens
// every wiki view and dialog, and prints whether anything ran (xss must be 0).
const { chromium } = require("playwright");
const { spawn } = require("child_process");
const fs = require("fs"), os = require("os"), path = require("path");
const X = `"><img src=x onerror=__xss=1>`;
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "czx-"));
  const srv = spawn(process.execPath, ["server.mjs"], { cwd: path.join(__dirname, ".."), env: { ...process.env, CEZEOS_DATA_DIR: dir, CEZEOS_PORT: "0", CEZEOS_ALLOW_DEMO: "1" } });
  const url = await new Promise((r) => srv.stdout.on("data", (c) => { const m = String(c).match(/http:\/\/127\.0\.0\.1:\d+\//); if (m) r(m[0]); }));
  const b = await chromium.launch();
  const p = await (await b.newContext()).newPage();
  const dialogs = []; p.on("dialog", (d) => { dialogs.push(d.message()); d.dismiss(); });
  await p.goto(url);
  const post = (path, body) => p.evaluate(async ([path, body]) => (await fetch("/api/" + path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })).json(), [path, body]);
  await post("session/demo", { name: X });
  const g = (await post("groups", { name: X, bio: X })).id;
  const art = (await post("wiki", { title: X, body: X + "\n" + X, category: X, group: g })).id;
  await post("wiki/" + art, { title: X + "2", body: X + "changed", category: X, revision: 1 });
  await post("groups/" + g + "/wiki", { mode: "suggest" });
  const s = await post("wiki/" + art + "/suggest", { title: X, body: X + "suggested", category: X, revision: 2 });
  const closeDlg = () => p.evaluate(() => { const d = document.getElementById("dialog"); if (d?.open) d.close(); });
  const clicks = async (sel) => { const n = await p.locator(sel).count(); if (n) { await p.locator(sel).first().click(); await p.waitForTimeout(300); } return n; };
  const views = ["#wiki", "#wiki/" + art, "#group/" + g, "#group-wiki/" + g];
  const opened = [];
  for (const v of views) { await p.goto(url + v); await p.waitForTimeout(500); opened.push(v); }
  await p.goto(url + "#wiki/" + art); await p.waitForTimeout(500);
  for (const a of ["wiki-history", "wiki-version", "wiki-diff"]) { if (a !== "wiki-history") { await closeDlg(); await p.goto(url + "#wiki/" + art); await p.waitForTimeout(400); await clicks('[data-action="wiki-history"]'); } else { await closeDlg(); await p.goto(url + "#wiki/" + art); await p.waitForTimeout(400); } opened.push(a + ":" + await clicks(`[data-action="${a}"]`)); }
  for (const a of ["wiki-log", "wiki-suggestion", "wiki-settings"]) { await closeDlg(); await p.goto(url + "#wiki/" + art); await p.waitForTimeout(400); opened.push(a + ":" + await clicks(`[data-action="${a}"]`)); }
  await p.goto(url + "#group-wiki/" + g); await p.waitForTimeout(400);
  for (const a of ["wiki-group-settings", "wiki-group-log"]) { await closeDlg(); await p.goto(url + "#group-wiki/" + g); await p.waitForTimeout(400); opened.push(a + ":" + await clicks(`[data-action="${a}"]`)); }
  const xss = await p.evaluate(() => window.__xss || 0); const me = await p.evaluate(async () => (await (await fetch("/api/session")).json()).profile?.name);
  const imgs = await p.evaluate(() => document.querySelectorAll('img[src="x"]').length);
  console.log(JSON.stringify({ me, xss, imgs, dialogs, opened, suggestion: Boolean(s.id) }));
  await b.close(); srv.kill();
})();
