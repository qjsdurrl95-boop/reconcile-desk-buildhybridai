import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildPacket, formatMoney, parsePriority, reconcile } from "../src/reconcile.js";

const invoiceHeader = "invoice_id,currency,amount_due\n";
const paymentHeader = "payment_id,invoice_id,currency,amount_received\n";
const demoInvoices = readFileSync(new URL("../public/demo-invoices.csv", import.meta.url), "utf8");
const demoPayments = readFileSync(new URL("../public/demo-payments.csv", import.meta.url), "utf8");

test("matches two sample invoices and finds five distinct exceptions", () => {
  const result = reconcile(demoInvoices, demoPayments);
  assert.equal(result.invoiceCount, 6);
  assert.equal(result.paymentCount, 7);
  assert.equal(result.matched, 2);
  assert.equal(result.reviewOnly, 1);
  assert.deepEqual(result.issues.map(({ kind, invoiceId, gap }) => [kind, invoiceId, gap]), [
    ["currency_mismatch", "EX-105", 95000n],
    ["unmatched", "EX-999", 2600n],
    ["overpaid", "EX-103", 1500n],
    ["partial", "EX-102", 12000n],
    ["unpaid", "EX-104", 8500n],
  ]);
});

test("adds split payments in exact minor units", () => {
  const result = reconcile(
    invoiceHeader + "I1,USD,0.3",
    paymentHeader + "P1,I1,USD,0.10\nP2,I1,USD,0.2",
  );
  assert.equal(result.matched, 1);
  assert.equal(result.issues.length, 0);
  assert.equal(formatMoney(1n, "USD"), "USD 0.01");
  assert.equal(formatMoney(35000n, "KRW"), "KRW 35,000");
});

test("keeps an invoice with different payment currencies out of matched and unpaid counts", () => {
  const result = reconcile(
    invoiceHeader + "I1,USD,45",
    paymentHeader + "P1,I1,USD,45\nP2,I1,KRW,100",
  );
  assert.equal(result.matched, 0);
  assert.equal(result.reviewOnly, 1);
  assert.deepEqual(result.issues.map((issue) => issue.kind), ["currency_mismatch"]);
});

test("accepts an empty payments file with valid headers and flags unpaid invoices", () => {
  assert.equal(reconcile(invoiceHeader + "I1,KRW,2000", paymentHeader).issues[0].kind, "unpaid");
});

test("rejects duplicate invoice or payment IDs instead of silently applying them", () => {
  assert.throws(() => reconcile(invoiceHeader + "I1,USD,10\nI1,USD,20", paymentHeader), /Duplicate invoice/);
  assert.throws(() => reconcile(invoiceHeader + "I1,USD,10", paymentHeader + "P1,I1,USD,5\nP1,I1,USD,5"), /Duplicate payment/);
});

test("rejects invalid headers, unsupported currency and malformed amounts", () => {
  assert.throws(() => reconcile("invoice_id,currency,currency\nI1,USD,10", paymentHeader), /duplicate column/);
  assert.throws(() => reconcile(invoiceHeader + "I1,GBP,10", paymentHeader), /USD or KRW/);
  assert.throws(() => reconcile(invoiceHeader + "I1,KRW,10.50", paymentHeader), /invalid amount_due/);
  assert.throws(() => reconcile(invoiceHeader + "I1,USD,-10", paymentHeader), /invalid amount_due/);
  assert.throws(() => reconcile(invoiceHeader + "I1,USD,1,5", paymentHeader), /invalid at data row/);
});

test("keeps identifiers, amounts and currencies out of the model packet", () => {
  const packet = buildPacket(reconcile(demoInvoices, demoPayments));
  assert.equal(packet.length, 5);
  for (const row of packet) assert.deepEqual(Object.keys(row).sort(), ["count", "kind"]);
  assert.doesNotMatch(JSON.stringify(packet), /EX-|PX-|USD|KRW|95000|12000/);
});

test("accepts only a complete permutation of actual exception categories", () => {
  const packet = [{ kind: "partial", count: 2 }, { kind: "unpaid", count: 1 }];
  assert.deepEqual(parsePriority('{"priority":["unpaid","partial"]}', packet), ["unpaid", "partial"]);
  assert.throws(() => parsePriority('{"priority":["unpaid","unpaid"]}', packet), /invalid review order/);
  assert.throws(() => parsePriority('{"priority":["unpaid","invented"]}', packet), /invalid review order/);
  assert.throws(() => parsePriority('{"priority":["partial"]}', packet), /invalid review order/);
});
