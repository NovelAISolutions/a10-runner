// ================================================
// A10 Runner — v3.5.1 Agentic Orchestrator (hardened)
// Architect (think) → Coder (build) → Tester (verify) → Quality (review)
// Parallel fan-out, feedback loop, multi-file commits
// Adds: commit retries, partial result reporting, CSS single-source
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

// ---------- Small utils ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const safeJson = (v) => (typeof v === "string" ? v : JSON.stringify(v));

// ---------- GitHub helpers (hardened) ----------
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) {
      console.log(`ℹ️  getFileShaOrNull: not found (new file): ${path}`);
      return null;
    }
    console.warn(`⚠️  getFileShaOrNull error for ${path}: ${err?.message}`);
    return null; // never throw here
  }
}

async function commitWithRetry({ owner, repo, path, message, contentUtf8, branch }, tries = 3) {
  const contentB64 = Buffer.from(contentUtf8, "utf8").toString("base64");
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
      const code = err?.status || err?.response?.status;
      const last = i === tries - 1;
      const msg = err?.message || String(err);
      console.warn(`⚠️  commit ${path} attempt ${i + 1}/${tries} failed: ${msg}`);
      if (!last) await sleep(400 * (i + 1));
      else return { ok: false, path, error: msg, code };
    }
  }
  return { ok: false, path, error: "unknown_commit_failure" };
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
    return { ok: true, deleted: true, path, status: resp?.status };
  } catch (err) {
    console.warn(`⚠️  deleteFileIfExists ${path} failed: ${err?.message}`);
    return { ok: false, deleted: false, path, error: err?.message };
  }
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
      contentUtf8: f.content,
      branch,
    });
    results.push(r);
    if (!r.ok) errors.push(r);
    // small pacing helps avoid API flaps
    await sleep(120);
  }
  return { results, errors };
}

// ---------- Orchestration helpers ----------
async function forward(path, payload) {
  const url = `${SELF_URL}${path}`;
  const body = JSON.stringify(payload && payload.payload ? payload : { payload });
  // Accept both styles; normalize to {payload:...}
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
  const text = await r.text();
  let j = {};
  try { j = JSON.parse(text); } catch { j = { raw: text }; }
  console.log(`➡️  Forwarded ${path} →`, j?.status || j?.result || j?.ok);
  return j;
}

function mergeFeedback(...chunks) {
  return chunks
    .filter(Boolean)
    .map((c) => (typeof c === "string" ? c : safeJson(c)))
    .join("\n\n");
}

// ---------- LLM brain (optional but powerful) ----------
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
          { role: "system", content: `You are the ${role} in a software build orchestra. Return concise JSON only. Schema hint:\n${schemaHint || "{}"}` },
          { role: "user", content: `${instruction}\n\nINPUT:\n${typeof input === "string" ? input : JSON.stringify(input)}` },
        ],
        response_format: { type: "json_object" },
      }),
    });
    const data = await resp.json();
    const txt = data?.choices?.[0]?.message?.content || "{}";
    return JSON.parse(txt);
  } catch (e) {
    console.warn(`⚠️  brain(${role}) fallback:`, e.message);
    return heuristicBrain({ role, instruction, input });
  }
}

// ---------- Heuristic brain (lightweight fallback) ----------
function heuristicBrain({ role, input }) {
  if (role === "architect") {
    const prd = typeof input === "string" ? input : (input?.prd || "");
    return {
      coder_plan: [
        "Create/ensure index.html with semantic sections.",
        "Create/ensure style.css with CSS variables and responsive grid.",
        "Create/ensure script.js with basic interactivity and validation.",
      ],
      tester_plan: [
        "Check presence of title and main sections.",
        "Validate email regex present in JS.",
        "Ensure grid layout classes exist in CSS.",
      ],
      quality_rules: [
        "No inline CSS except small utility styles.",
        "Use semantic HTML5 tags.",
        "Consistent indentation, class naming (kebab-case).",
      ],
      notes: prd.slice(0, 200),
    };
  }
  if (role === "coder") {
    return {
      files: [
        {
          path: "index.html",
          content:
            `<!doctype html><html lang="en"><head>\n` +
            `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">\n` +
            `<title>A10 Orchestrator Sandbox</title>\n` +
            `<link rel="stylesheet" href="style.css">\n` +
            `</head><body>\n<header class="hero"><h1>Welcome to A10</h1><p>Automated build sandbox</p></header>\n` +
            `<main id="app"></main>\n<script src="script.js"></script>\n</body></html>`,
        },
        {
          path: "style.css",
          content:
            `:root{--brand:#6b7cff;--bg:#0b0e12;--text:#e7e9ef}\n` +
            `body{background:var(--bg);color:var(--text);font-family:Inter,system-ui,-apple-system,sans-serif;margin:0}\n` +
            `.hero{padding:48px;text-align:center}\n` +
            `.grid{display:grid;gap:16px;grid-template-columns:repeat(auto-fit,minmax(220px,1fr))}\n`,
        },
        {
          path: "script.js",
          content:
            `console.log("A10 sandbox ready");\n` +
            `export function isValidEmail(s){return /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/.test(s)}\n`,
        },
      ],
      message: "Coder heuristic scaffold",
    };
  }
  if (role === "tester") {
    return {
      checks: [
        { id: "html_title", description: "index.html has a <title>", required: true },
        { id: "css_vars", description: "style.css has :root variables", required: true },
        { id: "js_email", description: "script.js has email validation", required: false },
      ],
    };
  }
  if (role === "quality") {
    return {
      rules: [
        "Avoid very long lines (>300 chars).",
        "No <style> blocks with 200+ inline rules.",
        "Use semantic tags in HTML.",
      ],
    };
  }
  return {};
}

// ---------- Health ----------
app.get("/health", (_req, res) =>
  res.json({ ok: true, message: "runner is alive", timestamp: new Date().toISOString() })
);

// ===================================================================
// Architect → fan-out (first to Coder; Coder will fan to Tester/Quality)
// ===================================================================
app.post("/run/architect", async (req, res) => {
  try {
    const payload = req.body?.payload || req.body || {};
    const { owner, repo } = payload;
    if (!owner || !repo) {
      return res.status(400).json({ ok: false, error: "Missing owner/repo" });
    }

    const arch = await brain({
      role: "architect",
      instruction:
        "Break the PRD into (coder_plan: string[]), (tester_plan: string[]), (quality_rules: string[]). Return JSON.",
      input: payload.prd || payload,
      schemaHint: `{"coder_plan":["string"],"tester_plan":["string"],"quality_rules":["string"]}`,
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

    res.json({
      ok: true,
      agent: "architect",
      status: "planned",
      orchestration,
      forwarded: coderResp,
    });
  } catch (err) {
    console.error("💥 Architect error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Coder → commit files → parallel Tester + Quality
// ===================================================================
app.post("/run/coder", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;
    if (!owner || !repo) return res.status(400).json({ ok: false, error: "Missing owner/repo" });

    // Ask coder brain to produce/patch files (it can also use p.feedback)
    const coder = await brain({
      role: "coder",
      instruction:
        "Produce files array for repository based on coder_plan and optional feedback. Each item {path, content}.",
      input: { coder_plan: p.coder_plan, feedback: p.feedback },
      schemaHint: `{"files":[{"path":"string","content":"string"}],"message":"string"}`,
    });

    const defaultFiles = heuristicBrain({ role: "coder" }).files;
    const files = coder.files && coder.files.length ? coder.files : defaultFiles;

    // Standardize CSS: we will only use style.css; remove styles.css if present
    const cssCleanup = await deleteFileIfExists({ owner, repo, path: "styles.css", branch });

    // Commit all requested files (hardened, partial results)
    const { results, errors } = await commitMany({
      owner,
      repo,
      files: files.map((f) => ({ ...f, message: coder.message || "Coder update" })),
      message: coder.message || "Coder update",
      branch,
    });

    // Plan Tester & Quality
    const [testerPlan, qualityPlan] = await Promise.all([
      brain({
        role: "tester",
        instruction: "Create checks for this build. Return {checks:[{id,description,required}]}",
        input: p.tester_plan || [],
        schemaHint: `{"checks":[{"id":"string","description":"string","required":true}]}`,
      }),
      brain({
        role: "quality",
        instruction: "Create quality rules for this build. Return {rules:[string]}",
        input: p.quality_rules || [],
        schemaHint: `{"rules":["string"]}`,
      }),
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
      ok: errors.length === 0 && (!!testerResp?.ok || testerResp?.result === "passed"),
      agent: "coder",
      cssCleanup,
      results,
      errors,              // <<— you’ll see any per-file commit issues here
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
// Tester → quick static checks (+ LLM reasoning if available)
// ===================================================================
app.post("/run/tester", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;

    const html = (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) || "";
    const css = (await getTextFileOrNull({ owner, repo, path: "style.css", ref: branch })) || "";
    const js  = (await getTextFileOrNull({ owner, repo, path: "script.js", ref: branch })) || "";

    const results = [];
    const push = (id, ok, note) => results.push({ id, ok, note });

    const checks = (p.checks || []).concat([
      { id: "html_title", description: "index has <title>", required: true },
      { id: "css_vars",  description: "css has :root vars", required: true },
    ]);

    for (const c of checks) {
      let ok = true;
      if (c.id === "html_title") ok = /<title>[^<]+<\/title>/i.test(html);
      else if (c.id === "css_vars") ok = /:root\s*\{[^}]+\}/i.test(css);
      else if (c.id === "js_email") ok = /isValidEmail|@.+\./.test(js);
      push(c.id, !!ok, c.description);
    }

    let llmNotes = "";
    if (OPENAI_API_KEY) {
      const judge = await brain({
        role: "tester",
        instruction:
          "Given these files, do we miss any essential tests for a simple landing page with validation? Return {advice:string}",
        input: { html: html.slice(0, 8000), css: css.slice(0, 8000), js: js.slice(0, 8000) },
        schemaHint: `{"advice":"string"}`,
      });
      llmNotes = judge.advice || "";
    }

    const failed = results.some((r) => !r.ok);
    res.json({
      ok: !failed,
      agent: "tester",
      result: failed ? "failed" : "passed",
      details: results,
      advice: llmNotes,
    });
  } catch (err) {
    console.error("💥 Tester error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Quality Guardian → static rules + (optional) LLM review
// ===================================================================
app.post("/run/quality", async (req, res) => {
  try {
    const p = req.body?.payload || req.body || {};
    const { owner, repo, branch = "main" } = p;

    const html = (await getTextFileOrNull({ owner, repo, path: "index.html", ref: branch })) || "";
    const css  = (await getTextFileOrNull({ owner, repo, path: "style.css",  ref: branch })) || "";
    const js   = (await getTextFileOrNull({ owner, repo, path: "script.js", ref: branch })) || "";

    const rules = p.rules || [];
    const findings = [];

    const longLine = (s) => s.split("\n").some((ln) => ln.length > 300);
    if (longLine(html) || longLine(css) || longLine(js)) findings.push("Very long lines detected.");
    if (/<style[\s>]/i.test(html)) findings.push("Inline <style> detected. Prefer external CSS.");
    if (!/<main[\s>]/i.test(html)) findings.push("Semantic <main> tag missing.");

    let llmReview = "";
    let llmVerdict = "pass";
    if (OPENAI_API_KEY) {
      const review = await brain({
        role: "quality",
        instruction:
          "Review code against general web best practices (semantics, accessibility, modular CSS/JS). Return {review:string, verdict:'pass'|'fail'}",
        input: { rules, html: html.slice(0, 8000), css: css.slice(0, 8000), js: js.slice(0, 8000) },
        schemaHint: `{"review":"string","verdict":"pass"}`,
      });
      llmReview = review.review || "";
      llmVerdict = review.verdict || "pass";
      if (llmVerdict === "fail") findings.push("LLM review suggests failing quality gate.");
    }

    // Be a bit tolerant: only fail if there are >1 substantive findings or LLM says fail.
    const failed = findings.length > 1 || llmVerdict === "fail";
    res.json({
      ok: !failed,
      agent: "quality",
      status: failed ? "fail" : "pass",
      findings,
      review: llmReview,
    });
  } catch (err) {
    console.error("💥 Quality error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ===================================================================
// Integrator + Supervisor
// ===================================================================
app.post("/run/integrator", async (_req, res) => {
  try {
    res.json({ ok: true, agent: "integrator", status: "complete", timestamp: new Date().toISOString() });
  } catch (err) {
    console.error("💥 Integrator error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});
app.post("/run/supervisor", (_req, res) => {
  res.json({ ok: true, agent: "supervisor", status: "done", timestamp: new Date().toISOString() });
});

// ===================================================================
// Orchestrator “gate”: combine Tester + Quality, loop if needed
// ===================================================================
app.post("/run/gate", async (req, res) => {
  const p = req.body?.payload || req.body || {};
  const { tester, quality, orchestration } = p;
  if (!orchestration) return res.status(400).json({ ok: false, error: "Missing orchestration" });

  const testerFail  = tester?.result === "failed"  || tester?.ok === false;
  const qualityFail = quality?.status === "fail"   || quality?.ok === false;

  if (testerFail || qualityFail) {
    if ((orchestration.retries || 0) >= (orchestration.maxRetries || 2)) {
      return res.json({ ok: false, status: "gave_up", reason: "Max retries reached", tester, quality });
    }
    const feedback = mergeFeedback(
      tester?.advice || "",
      (tester?.details || []).map((d) => (!d.ok ? `TEST FAIL: ${d.id} — ${d.note}` : "")).join("\n"),
      (quality?.findings || []).map((f) => `QUALITY FINDING: ${f}`).join("\n"),
      quality?.review || ""
    );

    const next = { ...orchestration, retries: (orchestration.retries || 0) + 1, feedback };
    const coderResp = await forward("/run/coder", next);
    return res.json({ ok: true, status: "looped_to_coder", feedback, coder: coderResp });
  }

  const integ = await forward("/run/integrator", orchestration);
  const sv    = await forward("/run/supervisor",  orchestration);
  res.json({ ok: true, status: "proceed", integrator: integ, supervisor: sv });
});

// ---------- Start ----------
app.listen(PORT, () => console.log(`🚀 A10 Runner v3.5.1 agentic live on port ${PORT}`));
