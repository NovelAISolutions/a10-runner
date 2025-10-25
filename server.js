// ================================================
// A10 Runner — v3.5.3 Agentic Orchestrator
// Architect (think) → Coder (build) → Tester (verify) → Quality (review)
// Parallel fan-out, feedback loop, safe commits, automatic CSS cleanup
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";
import fetch from "node-fetch";

dotenv.config();
const app = express();

app.use(express.json({ limit: "10mb" }));
app.use(bodyParser.urlencoded({ extended: true }));
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Env ----------
const PORT = process.env.PORT || 10000;
const SELF_URL = process.env.SELF_URL?.replace(/\/+$/, "") || "https://a10-runner.onrender.com";
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";

if (!GITHUB_TOKEN) console.warn("⚠️  Missing GITHUB_TOKEN.");
if (!OPENAI_API_KEY) console.warn("ℹ️  OPENAI_API_KEY not set — using heuristic brains.");

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utilities ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ensureString = (v) =>
  typeof v === "string" ? v : v == null ? "" : JSON.stringify(v, null, 2);

// ---------- Core GitHub Helpers ----------
async function getTextFileOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    if (Array.isArray(data)) return null;
    return Buffer.from(data.content || "", "base64").toString("utf8");
  } catch (err) {
    if (err?.status === 404) return null;
    console.warn(`⚠️ getTextFileOrNull failed for ${path}:`, err.message);
    return null;
  }
}

async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) {
      console.log(`ℹ️ getFileShaOrNull: not found (new file): ${path}`);
      return null;
    }
    console.warn(`⚠️ getFileShaOrNull error for ${path}:`, err.message);
    return null;
  }
}

async function deleteFileIfExists({ owner, repo, path, branch }) {
  try {
    const ref = branch || "main";
    const sha = await getFileShaOrNull({ owner, repo, path, ref });
    if (!sha) return { ok: true, deleted: false, path };
    const resp = await octokit.repos.deleteFile({
      owner,
      repo,
      path,
      message: `Remove ${path} (standardize CSS path)`,
      sha,
      branch: ref,
    });
    console.log(`🗑️ Deleted old file: ${path}`);
    return { ok: true, deleted: true, path, status: resp?.status };
  } catch (err) {
    console.warn(`⚠️ deleteFileIfExists ${path} failed: ${err?.message}`);
    return { ok: false, deleted: false, path, error: err?.message };
  }
}

// ---------- Commit Helpers ----------
async function commitWithRetry({ owner, repo, path, message, contentUtf8, branch }, tries = 3) {
  const contentB64 = Buffer.from(ensureString(contentUtf8), "utf8").toString("base64");
  const ref = branch || "main";
  for (let i = 0; i < tries; i++) {
    try {
      const sha = await getFileShaOrNull({ owner, repo, path, ref });
      const resp = await octokit.repos.createOrUpdateFileContents({
        owner,
        repo,
        path,
        message,
        content: contentB64,
        branch: ref,
        ...(sha ? { sha } : {}),
      });
      return { ok: true, branch: ref, created: !sha, updated: !!sha, path, status: resp?.status };
    } catch (err) {
      const msg = err?.message || String(err);
      console.warn(`⚠️ commit ${path} attempt ${i + 1}/${tries} failed: ${msg}`);
      if (i < tries - 1) await sleep(400 * (i + 1));
      else return { ok: false, path, error: msg };
    }
  }
  return { ok: false, path, error: "unknown_commit_failure" };
}

async function commitMany({ owner, repo, files, message, branch }) {
  const results = [];
  const errors = [];
  for (const f of files) {
    const r = await commitWithRetry({
      owner,
      repo,
      path: f.path,
      message: f.message || message,
      contentUtf8: ensureString(f.content),
      branch,
    });
    results.push(r);
    if (!r.ok) errors.push(r);
    await sleep(100);
  }
  return { results, errors };
}

// ---------- Forward Helper ----------
async function forward(path, payload) {
  // Accept either {payload: ...} or raw object and wrap consistently
  const url = `${SELF_URL}${path}`;
  const body = JSON.stringify(payload?.payload ? payload : { payload });
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await r.text();
  let j = {};
  try {
    j = JSON.parse(text);
  } catch {
    j = { raw: text };
  }
  console.log(`➡️  Forwarded ${path} →`, j?.status || j?.result || j?.ok);
  return j;
}

function mergeFeedback(...chunks) {
  return chunks
    .filter(Boolean)
    .map((c) => (typeof c === "string" ? c : JSON.stringify(c, null, 2)))
    .join("\n\n");
}

// ---------- LLM + Heuristic Brains ----------
async function brain({ role, instruction, input, schemaHint }) {
  if (!OPENAI_API_KEY) return heuristicBrain({ role, instruction, input });
  try {
    const resp = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.3,
        messages: [
          {
            role: "system",
            content: `You are the ${role} in a software build orchestra. Return concise JSON only. Schema hint:\n${schemaHint || "{}"}`,
          },
          {
            role: "user",
            content: `${instruction}\n\nINPUT:\n${typeof input === "string" ? input : JSON.stringify(input)}`,
          },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const data = await resp.json();
    const txt = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(txt);
  } catch (e) {
    console.warn(`⚠️ brain(${role}) fallback:`, e.message);
    return heuristicBrain({ role, instruction, input });
  }
}

function heuristicBrain({ role, input }) {
  if (role === "architect") {
    return {
      coder_plan: ["Create index.html", "Create style.css", "Create script.js"],
      tester_plan: ["Verify structure", "Check CSS link", "Check JS presence"],
      quality_rules: ["Follow HTML5 semantics", "Use CSS variables"],
    };
  }
  if (role === "coder") {
    return {
      files: [
        {
          path: "index.html",
          content:
            `<!doctype html><html><head><meta charset="utf-8">` +
            `<meta name="viewport" content="width=device-width,initial-scale=1">` +
            `<title>A10 Sandbox</title><link rel="stylesheet" href="style.css"></head>` +
            `<body><header class="hero"><h1>Welcome to A10</h1></header>` +
            `<main id="app"></main><script src="script.js"></script></body></html>`,
        },
        {
          path: "style.css",
          content: `:root{--brand:#6b7cff;--bg:#0b0e12;--text:#e7e9ef}
body{background:var(--bg);color:var(--text);font-family:Inter,system-ui,sans-serif;margin:0;padding:0}`,
        },
        { path: "script.js", content: `console.log("A10 sandbox ready");` },
      ],
      message: "Coder heuristic scaffold",
    };
  }
  if (role === "tester") return { checks: [{ id: "html_title" }, { id: "css_vars" }] };
  if (role === "quality") return { rules: ["No inline <style>", "Has <main>"] };
  return {};
}

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, message: "runner is alive", timestamp: new Date().toISOString() })
);

// ===================================================================
// Architect
// ===================================================================
app.post("/run/architect", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const { owner, repo } = payload;
    if (!owner || !repo) return res.status(400).json({ ok: false, error: "Missing owner/repo" });

    const arch = await brain({
      role: "architect",
      instruction: "Break down into coder/tester/quality plans",
      input: payload.prd || payload,
    });

    const orchestration = {
      runId: `run_${Date.now()}`,
      owner,
      repo,
      branch: payload.branch || "main",
      coder_plan: arch.coder_plan || [],
      tester_plan: arch.tester_plan || [],
      quality_rules: arch.quality_rules || [],
      retries: 0,
      maxRetries: 2,
    };

    const coderResp = await forward("/run/coder", orchestration);
    res.json({ ok: true, agent: "architect", orchestration, forwarded: coderResp });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Coder → commits → Tester + Quality
// ===================================================================
app.post("/run/coder", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    if (!owner || !repo) return res.status(400).json({ ok: false, error: "Missing owner/repo" });

    // Either produce files from the "brain" or use verification task override
    let files;
    if (p.task) {
      // Deterministic verification content so you can assert GitHub updates
      files = [
        {
          path: "index.html",
          content: `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>A10 Sandbox</title>
<link rel="stylesheet" href="style.css">
</head><body>
<header class="hero"><h1>Welcome to A10</h1></header>
<main id="app"></main>
<footer data-a10="coder">Coder verification test ✅ (${new Date().toISOString()})</footer>
<script src="script.js"></script>
</body></html>`,
        },
        {
          path: "style.css",
          content: `/* a10 coder verification */
:root{--brand:#6b7cff;--bg:#0b0e12;--text:#e7e9ef}
body{background:#cfe8ff;color:var(--text);font-family:Inter,system-ui,sans-serif;margin:0;padding:0}
.hero{padding:32px;text-align:center}`,
        },
        {
          path: "script.js",
          content: `console.log("A10 coder verification executed at ${new Date().toISOString()}");`,
        },
      ];
    } else {
      const coder = await brain({
        role: "coder",
        instruction: "Generate files for sandbox",
        input: { coder_plan: p.coder_plan, feedback: p.feedback },
      });
      files = coder.files?.length ? coder.files : heuristicBrain({ role: "coder" }).files;
    }

    // CSS cleanup for legacy filename
    const cssCleanup = await deleteFileIfExists({ owner, repo, path: "styles.css", branch });

    // Commit
    const { results, errors } = await commitMany({
      owner,
      repo,
      files: files.map((f) => ({ ...f, content: ensureString(f.content) })),
      message: p.message || "Coder update",
      branch,
    });

    // Prepare downstream checks
    const [testerPlan, qualityPlan] = await Promise.all([
      brain({ role: "tester", input: p.tester_plan || [] }),
      brain({ role: "quality", input: p.quality_rules || [] }),
    ]);

    const common = {
      owner,
      repo,
      branch,
      runId: p.runId || `run_${Date.now()}`,
      retries: p.retries || 0,
      maxRetries: p.maxRetries || 2,
      checks: testerPlan.checks || [],
      rules: qualityPlan.rules || [],
    };

    const [testerResp, qualityResp] = await Promise.all([
      forward("/run/tester", common),
      forward("/run/quality", common),
    ]);

    res.json({
      ok: errors.length === 0,
      agent: "coder",
      cssCleanup,
      results,
      errors,
      next: ["tester", "quality"],
      tester: testerResp,
      quality: qualityResp,
    });
  } catch (err) {
    console.error("💥 Coder error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Tester
// ===================================================================
app.post("/run/tester", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    const html = (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) || "";
    const css  = (await getTextFileOrNull({ owner, repo, path: "style.css", ref: branch })) || "";

    const ok = /<title>[^<]+<\/title>/i.test(html) && /:root\s*\{[^}]+\}/i.test(css);
    res.json({ ok, agent: "tester", result: ok ? "passed" : "failed" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Quality
// ===================================================================
app.post("/run/quality", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    const html = (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) || "";
    const ok = /<main[\s>]/i.test(html);
    res.json({ ok, agent: "quality", status: ok ? "pass" : "fail" });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Integrator + Supervisor + Gate
// ===================================================================
app.post("/run/integrator", async (_req, res) =>
  res.json({ ok: true, agent: "integrator", status: "complete" })
);

app.post("/run/supervisor", async (_req, res) =>
  res.json({ ok: true, agent: "supervisor", status: "done" })
);

app.post("/run/gate", async (req, res) => {
  const p = req.body?.payload || req.body || {};
  const { tester, quality, orchestration } = p;
  if (!orchestration) return res.status(400).json({ ok: false, error: "Missing orchestration" });

  const testerFail  = tester?.ok === false || tester?.result === "failed";
  const qualityFail = quality?.ok === false || quality?.status === "fail";

  if (testerFail || qualityFail) {
    const next = { ...orchestration, retries: (orchestration.retries || 0) + 1 };
    const coderResp = await forward("/run/coder", next);
    return res.json({ ok: true, status: "looped_to_coder", coder: coderResp });
  }

  const integ = await forward("/run/integrator", orchestration);
  const sv    = await forward("/run/supervisor", orchestration);
  res.json({ ok: true, status: "proceed", integrator: integ, supervisor: sv });
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner v3.5.3 agentic live on port ${PORT}`));
