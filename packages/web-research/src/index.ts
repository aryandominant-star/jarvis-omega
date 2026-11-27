// Research output: turns the model's cited Markdown report into real HTML / PDF / DOCX files and verifies them.
// Live searching itself is done by Codex's built-in web search (web_search = "live") plus Playwright page reading.
import fs from "node:fs";
import path from "node:path";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function inline(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_m, t, u) => `<a href="${u}">${t}</a>`);
}

/** Small, safe Markdown subset → HTML (headings, lists, paragraphs, code, links, tables). */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let list: "ul" | "ol" | null = null;
  let code = false;
  let table: string[][] | null = null;
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const flushTable = () => {
    if (!table) return;
    const [head, ...rows] = table.filter((r) => !r.every((c) => /^:?-{3,}:?$/.test(c.trim())));
    out.push("<table><thead><tr>" + head.map((c) => `<th>${inline(c.trim())}</th>`).join("") + "</tr></thead><tbody>" +
      rows.map((r) => "<tr>" + r.map((c) => `<td>${inline(c.trim())}</td>`).join("") + "</tr>").join("") + "</tbody></table>");
    table = null;
  };
  for (const line of lines) {
    if (line.startsWith("```")) { closeList(); flushTable(); out.push(code ? "</code></pre>" : "<pre><code>"); code = !code; continue; }
    if (code) { out.push(esc(line)); continue; }
    if (/^\s*\|.*\|\s*$/.test(line)) { closeList(); (table ??= []).push(line.trim().slice(1, -1).split("|")); continue; }
    flushTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ul = /^\s*[-*]\s+(.*)$/.exec(line);
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ul || ol) {
      const kind = ul ? "ul" : "ol";
      if (list !== kind) { closeList(); out.push(`<${kind}>`); list = kind; }
      out.push(`<li>${inline((ul ?? ol)![1])}</li>`);
      continue;
    }
    closeList();
    if (line.trim()) out.push(`<p>${inline(line)}</p>`);
  }
  closeList(); flushTable();
  if (code) out.push("</code></pre>");
  return out.join("\n");
}

export function reportHtml(title: string, md: string): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)}</title>
<style>body{font-family:Segoe UI,Arial,sans-serif;max-width:820px;margin:40px auto;padding:0 24px;line-height:1.55;color:#1b1f24}
h1{font-size:26px;border-bottom:2px solid #0a84ff;padding-bottom:6px}h2{font-size:20px;margin-top:28px}a{color:#0a63c9}
code{background:#f1f3f5;padding:1px 4px;border-radius:3px}pre{background:#f6f8fa;padding:12px;overflow:auto}
table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:6px 8px;text-align:left}
.meta{color:#57606a;font-size:13px}</style></head><body>
<h1>${esc(title)}</h1><p class="meta">Prepared by J.A.R.V.I.S. on ${new Date().toLocaleString()}</p>
${markdownToHtml(md)}</body></html>`;
}

export function safeFileName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "report";
}

async function toDocx(title: string, md: string, file: string) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const docx = require("docx");
  const { Document, Packer, Paragraph, HeadingLevel, TextRun, ExternalHyperlink } = docx;
  const runs = (text: string) => {
    const parts: any[] = [];
    const re = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*/g;
    let last = 0, m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      if (m.index > last) parts.push(new TextRun(text.slice(last, m.index)));
      if (m[1]) parts.push(new ExternalHyperlink({ link: m[2], children: [new TextRun({ text: m[1], style: "Hyperlink" })] }));
      else parts.push(new TextRun({ text: m[3], bold: true }));
      last = re.lastIndex;
    }
    if (last < text.length) parts.push(new TextRun(text.slice(last)));
    return parts;
  };
  const children: any[] = [new Paragraph({ text: title, heading: HeadingLevel.TITLE })];
  const levels = [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4];
  for (const line of md.replace(/\r\n/g, "\n").split("\n")) {
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    const li = /^\s*(?:[-*]|\d+[.)])\s+(.*)$/.exec(line);
    if (h) children.push(new Paragraph({ children: runs(h[2]), heading: levels[Math.min(h[1].length, 4) - 1] }));
    else if (li) children.push(new Paragraph({ children: runs(li[1]), bullet: { level: 0 } }));
    else if (line.trim() && !line.startsWith("```")) children.push(new Paragraph({ children: runs(line) }));
  }
  const doc = new Document({ creator: "J.A.R.V.I.S.", title, sections: [{ children }] });
  fs.writeFileSync(file, await Packer.toBuffer(doc));
}

export interface ExportResult { path: string; bytes: number; format: string }

export async function exportReport(opts: {
  title: string; markdown: string; format: "md" | "html" | "pdf" | "docx"; dir: string; fileName?: string;
  htmlToPdf: (html: string, pdf: string) => Promise<void>;
}): Promise<ExportResult> {
  fs.mkdirSync(opts.dir, { recursive: true });
  const base = safeFileName(opts.fileName || opts.title).replace(/\.(md|html|pdf|docx)$/i, "");
  const file = path.join(opts.dir, `${base}.${opts.format}`);
  if (opts.format === "md") fs.writeFileSync(file, `# ${opts.title}\n\n${opts.markdown}\n`, "utf8");
  else if (opts.format === "html") fs.writeFileSync(file, reportHtml(opts.title, opts.markdown), "utf8");
  else if (opts.format === "docx") await toDocx(opts.title, opts.markdown, file);
  else {
    const tmpHtml = path.join(opts.dir, `.${base}.${Date.now()}.html`);
    fs.writeFileSync(tmpHtml, reportHtml(opts.title, opts.markdown), "utf8");
    try { await opts.htmlToPdf(tmpHtml, file); } finally { fs.rmSync(tmpHtml, { force: true }); }
  }
  // Verify the file really exists and is non-empty before reporting success.
  const st = fs.statSync(file);
  if (!st.size) throw new Error(`Export produced an empty file: ${file}`);
  return { path: file, bytes: st.size, format: opts.format };
}
