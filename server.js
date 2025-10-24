import express from "express";
import bodyParser from "body-parser";
import fetch from "node-fetch";

const app = express();
app.use(bodyParser.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// --- Helper functions ---
async function callOpenAI(model, prompt) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }]
    })
  });
  return r.json();
}

async function commitToGitHub(owner, repo, path, content, message, branch = "main") {
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    headers: {
      "Authorization": `Bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      message,
      content: Buffer.from(content).toString("base64"),
      branch
    })
  });
  return r.json();
}

// --- Core /run endpoint ---
app.post("/run", async (req, res) => {
  try {
    const { action, payload } = req.body;

    // 1️⃣ Basic chat
    if (action === "openai.chat") {
      const result = await callOpenAI(payload.model, payload.prompt);
      return res.json({
        ok: true,
        action,
        result: {
          ok: true,
          model: payload.model,
          text: result.choices?.[0]?.message?.content ?? "(no text)"
        }
      });
    }

    // 2️⃣ Direct commit
    if (action === "github.commit") {
      const result = await commitToGitHub(
        payload.owner,
        payload.repo,
        payload.path,
        payload.content,
        payload.message,
        payload.branch
      );
      return res.json({ ok: true, action, result });
    }

    // 3️⃣ ✨ Edit + Commit (improved)
    if (action === "openai.edit-and-commit") {
      // Step 1: Get current file from GitHub
      const ghFile = await fetch(
        `https://api.github.com/repos/${payload.owner}/${payload.repo}/contents/${payload.path}`,
        { headers: { "Authorization": `Bearer ${process.env.GITHUB_TOKEN}` } }
      );
      const ghJson = await ghFile.json();
      const original = Buffer.from(ghJson.content, "base64").toString("utf-8");

      // Step 2: Ask OpenAI to rewrite only the body, not the whole HTML tag
      const prompt = `
You are a precise code editor.
Take this HTML and ${payload.instruction}.
Return only valid HTML, no commentary or markdown fences.

--- HTML START ---
${original}
--- HTML END ---
`;
      const aiResult = await callOpenAI(payload.model, prompt);

      // Some models return ```html``` fenced blocks; strip them if present
      let newHtml = aiResult.choices?.[0]?.message?.content ?? original;
      newHtml = newHtml
        .replace(/^```html/i, "")
        .replace(/^```/i, "")
        .replace(/```$/i, "")
        .trim();

      // Step 3: Commit back
      const result = await commitToGitHub(
        payload.owner,
        payload.repo,
        payload.path,
        newHtml,
        payload.message,
        payload.branch
      );

      return res.json({
        ok: true,
        action,
        result: { ok: true, commitSha: result.commit?.sha ?? null }
      });
    }

    return res.status(400).json({ ok: false, error: "Unknown or missing action", action });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

    // Unknown action
    return res.status(400).json({
      ok: false,
      error: "Unknown or missing action",
      action
    });

  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.listen(10000, () => {
  console.log("🚀 A10 Runner listening on port 10000");
  console.log("✅ Your service is live 🎉");
});
