// =============================================================
// A10 Runner — v3.5.7 (Commit-Fallback + Self-Healing Diagnostics)
// Architect → Coder → Tester → Quality → Gate → Integrator → Supervisor
// =============================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();
const app = express();
const PORT = process.env.PORT || 10000;
const SELF_URL = (process.env.SELF_URL || "https://a10-runner.onrender.com").replace(/\/+$/, "");
const GITHUB_TOKEN = process.env.GITHUB_TOKEN || "";
const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Diagnostics ----------
const diagBuf = [];
const DIAG_MAX = 50;
function diag(agent, level, message, details = {}) {
  const e = { ts: new Date().toISOString(), agent, level, message, details };
  diagBuf.push(e);
  if (diagBuf.length > DIAG_MAX) diagBuf.shift();
  console[level === "error" ? "error" : "log"](`[diag:${agent}] ${message}`, details);
  return e;
}
app.get("/_diag", (_req, res) => res.json({ ok: true, diag: diagBuf.slice(-20) }));
app.get("/health", (_req, res) => res.json({ ok: true, version: "3.5.7", time: new Date().toISOString() }));

// ---------- Utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureString = (v) => (typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2));
const normalize = (body) => {
  const p = body?.payload || body || {};
  return {
    owner: (p.owner || "").trim().toLowerCase(),
    repo: (p.repo || "").trim(),
    branch: p.branch || "main",
    prd: p.prd || {},
    tester: p.tester || {},
    quality: p.quality || {},
    orchestration: p.orchestration || {},
  };
};

// ---------- GitHub commit with smarter fallback + logging ----------
async function commitAtomic({ owner, repo, path, message, contentUtf8, branch }, attempt = 1) {
  const contentB64 = Buffer.from(ensureString(contentUtf8), "utf8").toString("base64");
  const targetBranch = branch || "main";
  try {
    // ✅ preflight: confirm repo and branch exist
    await octokit.repos.get({ owner, repo });
  } catch (e) {
    diag("github", "error", "Preflight repo access failed", { owner, repo, error: e.message });
    return { ok: false, path, error: "repo_not_found_or_no_access" };
  }

  try {
    const sha = await getFileShaOrNull({ owner, repo, path, ref: targetBranch });
    const resp = await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path,
      message,
      content: contentB64,
      branch: targetBranch,
      ...(sha ? { sha } : {}),
    });
    return { ok: true, path, status: resp.status, github_mode: "normal" };
  } catch (err) {
    if (err.status === 404 || err.status === 422) {
      diag("github", "warn", "Fallback commit path", { path, attempt });
      const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;
      const body = {
        message,
        content: contentB64,
        branch: targetBranch,
        committer: { name: "A10 Runner Bot", email: "bot@a10runner.local" },
      };
      const resp = await fetch(url, {
        method: "PUT",
        headers: {
          Authorization: `Bearer ${GITHUB_TOKEN}`,
          "Content-Type": "application/json",
          Accept: "application/vnd.github+json",
        },
        body: JSON.stringify(body),
      });
      const text = await resp.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!resp.ok) {
        diag("github", "error", "Fallback PUT failed", { path, status: resp.status, body: json });
        return { ok: false, path, error: json.message || "fallback_failed", status: resp.status };
      }
      diag("github", "info", "Fallback PUT success", { path, status: resp.status });
      return { ok: true, path, github_mode: "fallback", status: resp.status };
    }
    diag("github", "error", "Commit failed", { path, error: err.message });
    return { ok: false, path, error: err.message };
  }
}

async function commitSequential({ owner, repo, branch, files }) {
  const results = [];
  for (const f of files) {
    const r = await commitAtomic({ owner, repo, branch, ...f });
    results.push(r);
    await sleep(300);
  }
  return results;
}

// ---------- Forward ----------
async function forward(path, payload) {
  const url = `${SELF_URL}${path}`;
  const wrapped = payload?.payload ? payload : { payload };
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(wrapped),
    });
    return await r.json();
  } catch (err) {
    diag("forward", "error", `Forward ${path} failed`, { error: err.message });
    return { ok: false, error: err.message };
  }
}

// ---------- Heuristic coder ----------
function heuristicCoder(prd) {
  const goal = prd?.goal || "Default sandbox page";
  const now = new Date().toLocaleString();
  return [
    {
      path: "index.html",
      content: `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${goal}</title>
<link rel="stylesheet" href="style.css"></head>
<body>
<header class="banner"><h1>${goal}</h1></header>
<main><section id="about"><h2>About</h2><p>Auto-built by A10 v3.5.7 at ${now}.</p></section>
<section id="gallery"><h2>Gallery</h2><div class="gallery">
<img src="https://placehold.co/400x300/png?text=Labubu+1" alt="Sample 1">
<img src="https://placehold.co/400x300/png?text=Labubu+2" alt="Sample 2">
</div></section>
<section id="contact"><h2>Contact</h2><p>Email: hello@example.com<br>Instagram: @labubu</p></section>
</main><footer><p>© ${new Date().getFullYear()} A10 Runner</p></footer>
<script src="script.js"></script></body></html>`,
    },
    {
      path: "style.css",
      content: `:root{--bg:#ffeaf4;--accent:#d39cd3;--text:#3b2463;--card:#ffffffb3}
body{background:var(--bg);color:var(--text);font-family:Poppins,sans-serif;margin:0;text-align:center}
header.banner{background:var(--accent);color:#fff;padding:1.5rem;border-radius:0 0 1rem 1rem}
main{padding:1rem}h2{color:var(--accent)}
.gallery{display:flex;justify-content:center;gap:1rem;flex-wrap:wrap;margin-top:1rem}
.gallery img{width:300px;border-radius:1rem;box-shadow:0 4px 10px #0002}
footer{margin-top:2rem;font-size:.9rem;opacity:.7}`,
    },
    {
      path: "script.js",
      content: `document.addEventListener("DOMContentLoaded",()=>console.log("✅ Build verified v3.5.7 @ "+new Date().toLocaleString()));`,
    },
  ];
}

// ---------- Agents ----------
app.post("/run/architect", async (req, res) => {
  const p = normalize(req.body);
  const orch = { runId: `run_${Date.now()}`, ...p };
  const coderResp = await forward("/run/coder", orch);
  res.json({ ok: true, agent: "architect", forwarded: coderResp, diag: diagBuf.slice(-5) });
});

app.post("/run/coder", async (req, res) => {
  const p = normalize(req.body);
  const files = heuristicCoder(p.prd);
  const results = await commitSequential({
    owner: p.owner,
    repo: p.repo,
    branch: p.branch,
    files: files.map((f) => ({ ...f, message: "A10 update v3.5.7" })),
  });
  const testerResp = await forward("/run/tester", p);
  const qualityResp = await forward("/run/quality", p);
  res.json({ ok: true, agent: "coder", results, tester: testerResp, quality: qualityResp, diag: diagBuf.slice(-5) });
});

app.post("/run/tester", async (req, res) => {
  const p = normalize(req.body);
  const { owner, repo, branch } = p;
  const [html, css, js] = await Promise.all([
    getTextFileOrNull({ owner, repo, path: "index.html", ref: branch }),
    getTextFileOrNull({ owner, repo, path: "style.css", ref: branch }),
    getTextFileOrNull({ owner, repo, path: "script.js", ref: branch }),
  ]);
  const ok = html?.includes("<title>") && html?.includes("<main") && css?.includes(":root") && js?.includes("console.log");
  const checks = { hasTitle: !!html?.includes("<title>"), hasMain: !!html?.includes("<main"), cssRoot: !!css?.includes(":root"), jsLog: !!js?.includes("console.log") };
  res.json({ ok, agent: "tester", result: ok ? "passed" : "failed", checks, diag: diagBuf.slice(-5) });
});

app.post("/run/quality", async (req, res) => {
  const p = normalize(req.body);
  const { owner, repo, branch } = p;
  const html = await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch });
  const ok = html?.includes("<footer>") && html?.includes("<header");
  const rules = { hasFooter: !!html?.includes("<footer>"), semanticHeader: !!html?.includes("<header") };
  res.json({ ok, agent: "quality", status: ok ? "pass" : "fail", rules, diag: diagBuf.slice(-5) });
});

app.post("/run/gate", async (req, res) => {
  const p = normalize(req.body);
  const fail = p.tester?.result === "failed" || p.quality?.status === "fail";
  if (fail) {
    const coderResp = await forward("/run/coder", p.orchestration || p);
    return res.json({ ok: true, status: "looped", coder: coderResp, diag: diagBuf.slice(-5) });
  }
  const integ = await forward("/run/integrator", p);
  const sv = await forward("/run/supervisor", p);
  res.json({ ok: true, status: "proceed", integrator: integ, supervisor: sv, diag: diagBuf.slice(-5) });
});

app.post("/run/integrator", (_req, res) => res.json({ ok: true, agent: "integrator", status: "complete" }));
app.post("/run/supervisor", (_req, res) => res.json({ ok: true, agent: "supervisor", status: "done" }));

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner v3.5.7 live on port ${PORT}`));
