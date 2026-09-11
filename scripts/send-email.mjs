/**
 * Speak First — screenshot delivery over the Resend REST API.
 *
 * One email per run, every PNG attached as base64. Delivery only: this module
 * never posts anywhere, and the body says so out loud.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";

const RESEND_ENDPOINT = "https://api.resend.com/emails";
const FROM = "onboarding@resend.dev";

// Resend caps a message at 40MB of attachments. Stay comfortably under it so a
// long landing page never silently bounces the whole batch.
const MAX_ATTACHMENT_BYTES = 30 * 1024 * 1024;

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Human label for a file, looked up from the shot list by slug. */
function labelFor(file, shots) {
  const shot = shots.find((s) => file.includes(`_${s.slug}_`));
  const size = file.includes("_mobile") ? "mobile" : file.includes("_desktop") ? "desktop" : "";
  return shot ? `${shot.label}${size ? ` — ${size}` : ""}` : file;
}

/**
 * Read every captured PNG, trimming the largest first if the batch would blow
 * past the attachment ceiling. Returns the attachments plus anything omitted.
 */
async function buildAttachments(outDir, captured) {
  const files = [];
  for (const { file } of captured) {
    const full = path.join(outDir, file);
    const { size } = await stat(full);
    files.push({ file, full, size });
  }

  const omitted = [];
  let total = files.reduce((sum, f) => sum + f.size, 0);
  while (total > MAX_ATTACHMENT_BYTES && files.length > 1) {
    // Drop the heaviest shot — always one of the long full-page captures.
    files.sort((a, b) => b.size - a.size);
    const dropped = files.shift();
    omitted.push(dropped);
    total -= dropped.size;
    console.warn(`  ! ${dropped.file} omitted (${mb(dropped.size)}) — batch over the ${mb(MAX_ATTACHMENT_BYTES)} attachment budget`);
  }

  // Back to capture order so the email reads top-to-bottom as it was shot.
  const order = captured.map((c) => c.file);
  files.sort((a, b) => order.indexOf(a.file) - order.indexOf(b.file));

  const attachments = [];
  for (const f of files) {
    attachments.push({ filename: f.file, content: (await readFile(f.full)).toString("base64") });
  }
  return { attachments, omitted, totalBytes: total };
}

function buildHtml({ date, siteUrl, attachments, shots, failed, skipped, omitted }) {
  const li = (items) => items.map((t) => `<li>${t}</li>`).join("\n      ");

  const attached = li(
    attachments.map((a) => `<strong>${escapeHtml(labelFor(a.filename, shots))}</strong><br><code>${escapeHtml(a.filename)}</code>`)
  );

  const problems = [...failed, ...skipped, ...omitted.map((o) => ({ file: o.file, note: "too large to attach" }))];
  const problemBlock = problems.length
    ? `<p style="color:#8a6d3b;margin:20px 0 6px"><strong>Not attached</strong></p>
    <ul style="margin:0;padding-left:20px;color:#8a6d3b">
      ${li(problems.map((p) => `<code>${escapeHtml(p.file)}</code>${p.note ? ` — ${escapeHtml(p.note)}` : ""}`))}
    </ul>`
    : "";

  return `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;color:#1a1a1a;max-width:560px">
    <p style="margin:0 0 4px"><strong>Speak First — screenshots for ${escapeHtml(date)}</strong></p>
    <p style="margin:0 0 16px;color:#666;font-size:13px">Captured from <a href="${escapeHtml(siteUrl)}" style="color:#666">${escapeHtml(siteUrl)}</a></p>

    <p style="margin:0 0 6px"><strong>Attached (${attachments.length})</strong></p>
    <ul style="margin:0;padding-left:20px">
      ${attached}
    </ul>

    ${problemBlock}

    <p style="margin:24px 0 0;padding-top:14px;border-top:1px solid #e5e5e5;color:#444">
      Add a caption and post. Nothing auto-publishes.
    </p>
  </div>`;
}

export async function sendScreenshotEmail({ date, siteUrl, outDir, shots, captured, failed, skipped }) {
  const apiKey = process.env.RESEND_API_KEY;
  const recipient = process.env.AGENT_RECIPIENT_EMAIL;

  const missing = [
    !apiKey && "RESEND_API_KEY",
    !recipient && "AGENT_RECIPIENT_EMAIL",
  ].filter(Boolean);
  if (missing.length) {
    console.error(`\nCannot send email — missing env: ${missing.join(", ")}`);
    console.error(`PNGs are still on disk at ${outDir}.`);
    process.exit(1);
  }

  const to = recipient.split(",").map((a) => a.trim()).filter(Boolean);

  console.log("\nPreparing email…");
  const { attachments, omitted, totalBytes } = await buildAttachments(outDir, captured);
  console.log(`  ${attachments.length} attachment(s), ${mb(totalBytes)} total`);

  const payload = {
    from: FROM,
    to,
    subject: `Speak First — fresh screenshots ${date}`,
    html: buildHtml({ date, siteUrl, attachments, shots, failed, skipped, omitted }),
    attachments,
  };

  let response;
  try {
    response = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });
  } catch (err) {
    console.error(`\nResend request failed: ${err.message}`);
    process.exit(1);
  }

  const body = await response.text();
  if (!response.ok) {
    console.error(`\nResend returned ${response.status} ${response.statusText}`);
    console.error(body);
    process.exit(1);
  }

  let id = "";
  try {
    id = JSON.parse(body).id || "";
  } catch {
    /* a 2xx without a parseable body is still a send */
  }
  console.log(`Email sent to ${to.join(", ")}${id ? ` (id ${id})` : ""}`);
}
