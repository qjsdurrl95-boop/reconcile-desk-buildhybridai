import "./style.css";
import { ISSUE_TYPES, buildPacket, formatMoney, reconcile } from "./reconcile.js";
import { canAllowCloud, canUseDevice, prioritize } from "./model.js";

const get = (id) => document.getElementById(id);
const MAX_UPLOAD_BYTES = 4_000_000;
const modelButtons = [
  { button: get("device-ai"), configured: canUseDevice },
  { button: get("hybrid-ai"), configured: canAllowCloud },
];
const memoSource = get("memo-source");
const aiStatus = get("ai-status");
let memoState = null;
let dataRevision = 0;
let busy = false;

function updateModelButtons() {
  for (const { button, configured } of modelButtons) button.disabled = busy || !configured;
}

function setDataStatus(text, error = false) {
  const status = get("data-status");
  status.textContent = text;
  status.classList.toggle("error", error);
}

function renderExceptions(issues, body) {
  body.replaceChildren();
  if (issues.length === 0) {
    const cell = body.insertRow().insertCell();
    cell.colSpan = 3;
    cell.textContent = "No exceptions found.";
    return;
  }
  for (const issue of issues) {
    const row = body.insertRow();
    row.insertCell().textContent = ISSUE_TYPES[issue.kind].label;
    const reference = row.insertCell();
    reference.textContent = issue.invoiceId;
    if (issue.paymentId) {
      const payment = document.createElement("small");
      payment.textContent = issue.paymentId;
      reference.append(payment);
    }
    row.insertCell().textContent = formatMoney(issue.gap, issue.currency);
  }
}

function renderMemo(priority, packet, source) {
  memoSource.textContent = source;
  const items = get("memo-items");
  items.replaceChildren();
  if (priority.length === 0) {
    const item = document.createElement("li");
    item.textContent = "No follow-up is needed for these files.";
    items.append(item);
  }
  const counts = new Map(packet.map(({ kind, count }) => [kind, count]));
  for (const kind of priority) {
    const item = document.createElement("li");
    const issue = ISSUE_TYPES[kind];
    const label = document.createElement("strong");
    label.textContent = issue.label + " (" + counts.get(kind) + ")";
    const action = document.createElement("span");
    action.textContent = issue.verb;
    item.append(label, action);
    items.append(item);
  }
}

function showResults(result) {
  get("invoice-count").textContent = result.invoiceCount;
  get("payment-count").textContent = result.paymentCount;
  get("matched-count").textContent = result.matched;
  get("issue-count").textContent = result.issues.length;
  get("exceptions-note").textContent = result.reviewOnly
    ? "Invoices with mixed currencies stay in review until the source records are corrected."
    : "";
  renderExceptions(result.issues, get("issue-rows"));

  const packet = buildPacket(result);
  memoState = { packet };
  renderMemo(packet.map(({ kind }) => kind), packet, "Rules-based order");
  get("ai-packet").textContent = JSON.stringify(packet, null, 2);
  get("ai-controls").hidden = packet.length === 0;
  updateModelButtons();
  aiStatus.textContent = "";
  if (packet.length && !canUseDevice) {
    aiStatus.textContent = "AI requires a Firebase web app. You can review the calculated exceptions now.";
  } else if (packet.length && !canAllowCloud) {
    aiStatus.textContent = "Cloud fallback is unavailable until App Check is configured.";
  }
  get("results").hidden = false;
}

async function readDemo(filename) {
  const response = await fetch(new URL(filename, document.baseURI));
  if (!response.ok) throw new Error("Sample data could not be loaded.");
  return response.text();
}

async function loadData(read, label) {
  const revision = ++dataRevision;
  setDataStatus("Reading files…");
  try {
    const [invoices, payments] = await read();
    if (revision !== dataRevision) return;
    showResults(reconcile(invoices, payments));
    setDataStatus(label);
  } catch (error) {
    if (revision !== dataRevision) return;
    get("results").hidden = true;
    memoState = null;
    setDataStatus(error.message, true);
  }
}

function loadDemo() {
  return loadData(() => Promise.all([
    readDemo("demo-invoices.csv"), readDemo("demo-payments.csv"),
  ]), "Sample data · fictional records");
}

async function readUpload(input) {
  const [file] = input.files;
  if (!file) throw new Error("Select both CSV files.");
  if (file.size > MAX_UPLOAD_BYTES) throw new Error("Each CSV must be at most 4 MB.");
  const bytes = await file.arrayBuffer();
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

async function useAI(route) {
  if (busy || !memoState || !canUseDevice || (route === "hybrid" && !canAllowCloud)) return;
  const current = memoState;
  busy = true;
  updateModelButtons();
  aiStatus.textContent = "Preparing your review order…";
  try {
    const { priority, inferenceSource } = await prioritize(route, current.packet, (progress) => {
      if (memoState === current && Number.isFinite(progress)) {
        aiStatus.textContent = "Preparing the on-device model (" + Math.round(progress * 100) + "%)…";
      }
    });
    if (memoState !== current) return;
    renderMemo(priority, current.packet, inferenceSource === "on_device" ? "On-device AI" : "Cloud fallback");
    aiStatus.textContent = "";
  } catch {
    if (memoState !== current) return;
    renderMemo(current.packet.map(({ kind }) => kind), current.packet, "Rules-based order");
    aiStatus.textContent = route === "device"
      ? "The on-device model was unavailable. Your CSV results are ready to review."
      : "AI prioritization was unavailable. Your CSV results are ready to review.";
  } finally {
    busy = false;
    updateModelButtons();
  }
}

get("load-demo").addEventListener("click", loadDemo);
get("import-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadData(() => Promise.all([readUpload(get("invoice-file")), readUpload(get("payment-file"))]), "Imported CSV files");
});
get("device-ai").addEventListener("click", () => void useAI("device"));
get("hybrid-ai").addEventListener("click", () => void useAI("hybrid"));
void loadDemo();
