// "jarvis" MCP server. Codex launches it over stdio for each task. It holds no state or authority of its
// own: every call is forwarded to the running agent over authenticated IPC, where permissions are enforced.
import readline from "node:readline";
import { ipcCall } from "./core/ipc";

const S = (props: Record<string, any>, required: string[] = []) => ({ type: "object", properties: props, required, additionalProperties: false });
const str = (description: string) => ({ type: "string", description });

export const TOOLS = [
  { name: "request_confirmation", description: "Ask the user to approve a high-risk action (payment, purchase, sending messages, deleting data, sharing files outside approved places, installing software, changing security settings). Blocks until the user answers. Returns APPROVED or DENIED.",
    inputSchema: S({ action: str("One line: exactly what you are about to do"), details: str("Amounts, recipients, files, URLs — what the user needs to decide"), risk: { type: "string", enum: ["low", "medium", "high"] } }, ["action", "details"]) },
  { name: "ask_user", description: "Ask the user a question when you are blocked (MFA code needed, ambiguous choice, CAPTCHA). Blocks until they answer.",
    inputSchema: S({ question: str("The question"), context: str("Why you need it") }, ["question"]) },
  { name: "vault_fill_login", description: "Type the saved username/password for a site into the login form currently open in the JARVIS browser. You never see the password. Does not submit — click the sign-in button afterwards.",
    inputSchema: S({ domain: str("Site domain, e.g. github.com"), username: str("Optional: which saved account") }, ["domain"]) },
  { name: "vault_list", description: "List sites (and usernames) that have saved credentials. Never returns passwords.", inputSchema: S({}) },
  { name: "list_apps", description: "Search installed applications on this PC.", inputSchema: S({ query: str("Optional filter, e.g. 'code' or 'chrome'") }) },
  { name: "launch_app", description: "Open an installed application by name (e.g. 'Visual Studio Code', 'Google Chrome').", inputSchema: S({ name: str("Application name") }, ["name"]) },
  { name: "list_windows", description: "List open application windows.", inputSchema: S({}) },
  { name: "focus_window", description: "Bring a window to the front by process id.", inputSchema: S({ pid: { type: "number" } }, ["pid"]) },
  { name: "search_files", description: "Find files by name (supports * wildcards) inside the approved directories.", inputSchema: S({ query: str("e.g. project-report.pdf or *.docx") }, ["query"]) },
  { name: "read_file", description: "Read a text file inside the approved directories.", inputSchema: S({ path: str("Absolute path") }, ["path"]) },
  { name: "export_report", description: "Save a Markdown report as md, html, pdf or docx in the workspace (or an approved directory) and verify the file exists. Include source links in the Markdown.",
    inputSchema: S({ title: str("Report title"), markdown: str("Report body in Markdown with citations"), format: { type: "string", enum: ["md", "html", "pdf", "docx"] }, fileName: str("Optional file name"), directory: str("Optional approved directory") }, ["title", "markdown", "format"]) },
  { name: "run_command", description: "Run a command the user pre-approved on this PC by name (e.g. 'build-tests'). Call with name '?' to list them.", inputSchema: S({ name: str("Command name") }, ["name"]) },
  { name: "memory_search", description: "Search JARVIS's long-term memory (preferences, projects, previous work).", inputSchema: S({ query: str("What to look for") }, ["query"]) },
  { name: "memory_save", description: "Remember a durable fact or preference for future tasks. Never store passwords or secrets.",
    inputSchema: S({ category: { type: "string", enum: ["preference", "context", "project", "website", "application", "document", "workflow", "research"] }, content: str("The fact to remember") }, ["category", "content"]) },
  { name: "system_info", description: "CPU, memory, disk, uptime and battery for this PC.", inputSchema: S({}) },
];

export function runMcpServer() {
  const taskId = process.env.JARVIS_TASK_ID ?? "";
  const send = (msg: unknown) => process.stdout.write(JSON.stringify(msg) + "\n");
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", async (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    const { id, method, params } = msg;
    if (id === undefined || id === null) return; // notifications
    try {
      if (method === "initialize") {
        return send({ jsonrpc: "2.0", id, result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jarvis", version: "1.0.0" },
          instructions: "Tools that act on the user's Windows PC through the J.A.R.V.I.S. agent. Permission limits are enforced by the agent.",
        } });
      }
      if (method === "ping") return send({ jsonrpc: "2.0", id, result: {} });
      if (method === "tools/list") return send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      if (method === "tools/call") {
        try {
          const out = await ipcCall<string>("tool", { taskId, name: params?.name, args: params?.arguments ?? {} });
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: typeof out === "string" ? out : JSON.stringify(out, null, 2) }] } });
        } catch (e: any) {
          return send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `Error: ${e.message}` }], isError: true } });
        }
      }
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    } catch (e: any) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: e.message } });
    }
  });
}
