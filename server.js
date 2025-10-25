// ================================================
// A10 Runner — Hardened backend for n8n workflow
// Stable Render-safe version (2025-10-25)
// ================================================

import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import { Octokit } from "@octokit/rest";

dotenv.config();

const app = express();

// ---------- Middleware ----------
app.use(express.json({ limit: "10mb" })); // parse JSON
app.use(bodyParser.urlencoded({ extended: true })); // ✅ handles n8n form-style payloads

// ---------- Simple Request Logger ----------
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------- Environment ----------
const PORT = process.env.PORT || 10000;
const GITHUB_TOKEN = process.env.GITHUB_TOKEN;

if (!GITHUB_TOKEN) {
  console.warn("⚠️  GITHUB_TOKEN missing — GitHub commits will fail.");
}

const octokit = new Octokit({ auth: GITHUB_TOKEN });

// ---------- Utilities ----------
async function getFileShaOrNull({ owner, repo, path, ref }) {
  try {
    const { data } = await octokit.repos.getContent({ owner, repo, path, ref });
    return Array.isArray(data) ? null : data.sha || null;
  } catch (err) {
    if (err?.status === 404) return null;
    throw err;
  }
}

async function createOrUpdateFile({ owner, repo, path, message, contentUtf8, branch }) {
  const contentB64 = Buffer.from(contentUtf8, "utf8").toString("base64");
  const ref = branch || "main";
  const sha = await getFileShaOrNull({ owner, repo, path, ref });

  await octokit.repos.createOrUpdateFileContents({
    owner,
    repo,
    path,
    message,
    content: contentB64,
    branch: ref,
    ...(sha ? { sha } : {}),
  });

  return { ok: true, branch: ref, created: !sha, updated: !!sha };
}

// ---------- Routes ----------
app.get("/health", (_req, res) => {
  res.json({ ok: true, message: "runner is alive", timestamp: new Date().toISOString() });
});

app.post("/echo", (req, res) => {
  res.json({ received: req.body });
});

app.post("/run/architect", async (_req, res) => {
  res.json({ ok: true, agent: "architect", note: "runner is alive" });
});

app.post("/run/coder", async (req, res) => {
  try {
    console.log("Incoming coder payload:", JSON.stringify(req.body, null, 2));

    const p = req.body?.payload || req.body || {};
    const owner = p.owner;
    const repo = p.repo;
    const branch = p.branch || "main";
    const path = p.path || "index.html";
    const message = p.message || "Automated commit";
    const content = p.content || "<html><body><h1>Hello from Coder</h1></body></html>";

    if (!owner || !repo) {
      console.log("❌ Missing owner or repo in payload:", p);
      return res.status(400).json({
        ok: false,
        reason: "bad_request",
        details: "Missing owner or repo",
        received: p,
      });
    }

    const result = await createOrUpdateFile({
      owner,
      repo,
      path,
      message,
      contentUtf8: content,
      branch,
    });

    console.log("✅ Commit success:", result);
    res.json({ ok: true, agent: "coder", result });
  } catch (err) {
    console.error("💥 Coder error:", err?.response?.data || err);
    res.status(500).json({
      ok: false,
      reason: "server_error",
      details: err?.response?.data || err.message,
    });
  }
});

// ---------- Default Stubs ----------
app.post("/run/tester", (_req, res) => res.json({ ok: true, tester: "passed" }));
app.post("/run/quality", (_req, res) => res.json({ ok: true, status: "pass" }));
app.post("/run/integrator", (_req, res) => res.json({ ok: true, integrator: "done" }));
app.post("/run/supervisor", (_req, res) => res.json({ ok: true, supervisor: "done" }));

// ---------- Start Server ----------
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
});
