import Papa from "papaparse";

const MAX_CHARS = 2_000_000;
const MAX_ROWS = 5000;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_./-]{0,63}$/;
const MONEY_FORMAT = { USD: 2, KRW: 0 };

export const ISSUE_TYPES = {
  currency_mismatch: { label: "Currency mismatch", verb: "Verify the original payment currency." },
  unmatched: { label: "Unmatched payment", verb: "Locate the missing invoice or correct the payment reference." },
  overpaid: { label: "Overpaid invoice", verb: "Confirm whether the excess is a credit or a data error." },
  partial: { label: "Partially paid invoice", verb: "Check whether another payment is expected." },
  unpaid: { label: "Unpaid invoice", verb: "Check the payment register before following up." },
};

function readCsv(text, file, headers) {
  if (typeof text !== "string" || text.length > MAX_CHARS) {
    throw new Error(`${file} must be a UTF-8 CSV of at most 2 million characters.`);
  }
  const { data, errors, meta } = Papa.parse(text, {
    delimiter: ",",
    header: true,
    skipEmptyLines: "greedy",
    transformHeader: (header) => header.trim(),
    transform: (value) => value.trim(),
  });
  if (meta.renamedHeaders && Object.keys(meta.renamedHeaders).length > 0) {
    throw new Error(`${file} has duplicate column headers.`);
  }
  if (errors.length) {
    throw new Error(`${file} is invalid at data row ${(errors[0].row ?? 0) + 1}.`);
  }
  if (meta.fields?.length !== headers.length || !headers.every((header) => meta.fields.includes(header))) {
    throw new Error(`${file} needs these columns: ${headers.join(", ")}.`);
  }
  if (data.length > MAX_ROWS) throw new Error(`${file} exceeds ${MAX_ROWS} data rows.`);
  return data;
}

function readMoney(row, field, where) {
  const currency = row.currency.toUpperCase();
  if (!Object.hasOwn(MONEY_FORMAT, currency)) {
    throw new Error(`${where} must use USD or KRW.`);
  }
  const digits = MONEY_FORMAT[currency];
  const value = row[field];
  const pattern = digits ? /^\d{1,12}(?:\.\d{1,2})?$/ : /^\d{1,12}$/;
  if (!pattern.test(value)) throw new Error(`${where} has an invalid ${field} for ${currency}.`);
  const [whole, fraction = ""] = value.split(".");
  const minor = BigInt(whole) * 10n ** BigInt(digits) + BigInt(fraction.padEnd(digits, "0") || "0");
  if (minor === 0n) throw new Error(`${where} needs a positive ${field}.`);
  return { currency, minor };
}

function readId(id, field, where) {
  if (!ID_PATTERN.test(id)) throw new Error(`${where} has an invalid ${field}.`);
  return id;
}

export function formatMoney(value, currency) {
  const digits = MONEY_FORMAT[currency];
  if (!digits) return `${currency} ${value.toLocaleString("en-US")}`;
  return `${currency} ${(value / 100n).toLocaleString("en-US")}.${String(value % 100n).padStart(2, "0")}`;
}

export function reconcile(invoiceCsv, paymentCsv) {
  const invoices = readCsv(invoiceCsv, "Invoices", ["invoice_id", "currency", "amount_due"]);
  const payments = readCsv(paymentCsv, "Payments", ["payment_id", "invoice_id", "currency", "amount_received"]);
  if (invoices.length === 0) throw new Error("Invoices must have at least one data row.");
  const byInvoice = new Map();
  for (const [index, row] of invoices.entries()) {
    const where = `Invoices data row ${index + 1}`;
    const id = readId(row.invoice_id, "invoice_id", where);
    if (byInvoice.has(id)) throw new Error(`Duplicate invoice ID ${id} in ${where.toLowerCase()}.`);
    const { currency, minor } = readMoney(row, "amount_due", where);
    byInvoice.set(id, { currency, due: minor, received: 0n, blocked: false });
  }

  const seenPayments = new Set();
  const issues = [];
  for (const [index, row] of payments.entries()) {
    const where = `Payments data row ${index + 1}`;
    const id = readId(row.payment_id, "payment_id", where);
    const invoiceId = readId(row.invoice_id, "invoice_id", where);
    if (seenPayments.has(id)) throw new Error(`Duplicate payment ID ${id} in ${where.toLowerCase()}.`);
    seenPayments.add(id);
    const { currency, minor } = readMoney(row, "amount_received", where);
    const invoice = byInvoice.get(invoiceId);
    if (!invoice) {
      issues.push({ kind: "unmatched", invoiceId, paymentId: id, currency, gap: minor });
    } else if (invoice.currency !== currency) {
      invoice.blocked = true;
      issues.push({ kind: "currency_mismatch", invoiceId, paymentId: id, currency, gap: minor });
    } else {
      invoice.received += minor;
    }
  }

  let matched = 0;
  let reviewOnly = 0;
  for (const [invoiceId, invoice] of byInvoice) {
    const { currency, due, received, blocked } = invoice;
    if (blocked) {
      reviewOnly++;
    } else if (received === due) {
      matched++;
    } else {
      const kind = received === 0n ? "unpaid" : received < due ? "partial" : "overpaid";
      issues.push({ kind, invoiceId, paymentId: null, currency, gap: received <= due ? due - received : received - due });
    }
  }

  const order = Object.keys(ISSUE_TYPES);
  issues.sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.invoiceId.localeCompare(b.invoiceId));
  return { issues, matched, reviewOnly, invoiceCount: invoices.length, paymentCount: payments.length };
}

export function buildPacket(result) {
  const counts = new Map();
  for (const { kind } of result.issues) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return Object.keys(ISSUE_TYPES).filter((kind) => counts.has(kind)).map((kind) => ({ kind, count: counts.get(kind) }));
}

export function parsePriority(text, packet) {
  const output = JSON.parse(text);
  const expected = new Set(packet.map(({ kind }) => kind));
  if (!Array.isArray(output?.priority) || output.priority.length !== expected.size ||
      !output.priority.every((kind) => expected.delete(kind))) {
    throw new Error("The model returned an invalid review order.");
  }
  return output.priority;
}
