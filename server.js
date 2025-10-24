// server.js — A10 Runner (Final Stable Version)
// ------------------------------------------------

// Import dependencies
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

// Environment setup
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(bodyParser.json({ limit: "5mb" }));

// Simple health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Helper: Call OpenAI Chat API ---
async function callOpenAI(model, instruction) {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: "You are a helpful assistant that writes motivational quotes." },
        { role: "user", content: instruction },
      ],
    }),
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    throw new Error(`OpenAI API failed: ${errorText}`);
  }

  const data = await resp.json();
  return data.choices?.[0]?.message?.content?.trim() || "(no result)";
}

// --- Helper: Commit to GitHub ---
async function commitToGitHub(owner, repo, path, content, message, branch) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Step 1: get file SHA
  const getRes = await fetch(apiUrl, {
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
    },
  });
  const fileData = await getRes.json();
  const sha = fileData.sha;

  // Step 2: prepare new content
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    sha,
  };

  // Step 3: commit update
  const putRes = await fetch(apiUrl, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  if (!putRes.ok) {
    const err = await putRes.text();
    console.error("❌ GitHub commit failed:", err);
    throw new Error(err);
  }

  const result = await putRes.json();
  console.log("✅ GitHub commit successful:", result.commit?.sha);
  return result.commit?.sha;
}

// --- Main runner endpoint ---
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    if (!action) {
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    if (action === "openai.edit-and-commit") {
      const {
        model,
        instruction,
        owner,
        repo,
        path,
        branch,
        message,
        commit,
      } = payload;

      // 1️⃣ Generate quote
      const quote = await callOpenAI(model, instruction);
      console.log("✨ Generated quote:", quote);

      // 2️⃣ Fetch existing file
      const fileUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
      const resp = await fetch(fileUrl);
      const oldContent = await resp.text();

      // 3️⃣ Inject quote into HTML
      const newContent = oldContent.replace(
        "</body>",
        `<p><em>"${quote}"</em></p></body>`
      );

      // 4️⃣ Commit if requested
      let commitSha = null;
      if (commit) {
        commitSha = await commitToGitHub(owner, repo, path, newContent, message, branch);
      }

      return res.json({
        ok: true,
        action,
        result: { ok: true, commitSha, quote },
      });
    }

    // Unknown action
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ Runner error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
  console.log(`✅ Your service is live 🎉`);
});
