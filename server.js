// server.js — A10 Runner (Final Stable + GitHub API Fix)
// ------------------------------------------------------

// Imports
import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

// Constants
const app = express();
const PORT = process.env.PORT || 10000;

// Middleware
app.use(bodyParser.json({ limit: "5mb" }));

// ------------------------------------------------------
// 1️⃣ Health check endpoint
// ------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// ------------------------------------------------------
// 2️⃣ Helper: Call OpenAI Chat API
// ------------------------------------------------------
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
        { role: "system", content: "You are a helpful assistant that writes short motivational quotes." },
        { role: "user", content: instruction },
      ],
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`OpenAI API error: ${errText}`);
  }

  const data = await resp.json();
  const text = data.choices?.[0]?.message?.content?.trim();
  return text || "Keep pushing forward — progress is progress!";
}

// ------------------------------------------------------
// 3️⃣ Helper: Commit file changes to GitHub
// ------------------------------------------------------
async function commitToGitHub(owner, repo, path, content, message, branch) {
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  // Get existing file SHA
  const getRes = await fetch(`${apiUrl}?ref=${branch}`, {
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github.v3+json",
    },
  });

  const fileData = await getRes.json();
  const sha = fileData.sha;

  // Prepare PUT body
  const body = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
    sha,
  };

  // Commit via GitHub API
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
    const errText = await putRes.text();
    console.error("❌ GitHub commit failed:", errText);
    throw new Error(`GitHub commit failed: ${errText}`);
  }

  const result = await putRes.json();
  console.log("✅ Commit successful:", result.commit?.sha);
  return result.commit?.sha;
}

// ------------------------------------------------------
// 4️⃣ Main: /run action handler
// ------------------------------------------------------
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    if (!action) {
      return res.status(400).json({ ok: false, error: "Missing action" });
    }

    // ---------------------------
    // openai.edit-and-commit
    // ---------------------------
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

      // 1️⃣ Generate a new motivational quote
      const quote = await callOpenAI(model, instruction);
      console.log("✨ Quote generated:", quote);

      // 2️⃣ Fetch current file via GitHub API (authenticated)
      const fileApiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
      const getFileRes = await fetch(fileApiUrl, {
        headers: {
          "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
          "Accept": "application/vnd.github.v3+json",
        },
      });

      if (!getFileRes.ok) {
        const errText = await getFileRes.text();
        throw new Error(`Failed to fetch file: ${errText}`);
      }

      const fileJson = await getFileRes.json();
      const oldContent = Buffer.from(fileJson.content, "base64").toString("utf8");

      // 3️⃣ Insert the new quote before </body>
      const newContent = oldContent.replace(
        "</body>",
        `<p><em>"${quote}"</em></p></body>`
      );

      // 4️⃣ Commit the updated file
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

    // ---------------------------
    // Unknown action
    // ---------------------------
    return res.status(400).json({ ok: false, error: `Unknown action: ${action}` });
  } catch (err) {
    console.error("❌ Runner error:", err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ------------------------------------------------------
// 5️⃣ Start server
// ------------------------------------------------------
app.listen(PORT, () => {
  console.log(`🚀 A10 Runner listening on port ${PORT}`);
  console.log(`✅ Your service is live at: https://a10-runner.onrender.com`);
});
