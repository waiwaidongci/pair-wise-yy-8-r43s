// 成品存档：领用落账、逐帘存档、余浆回缸与复核、失效重算、旧履历。
// 判定规则在 withdrawal.js，这里只负责把通过判定的业务事实写进批次。

import { remainingOf } from "./withdrawal.js";

function now() { return new Date().toISOString(); }
function rid(prefix) { return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function log(item, step, note) {
  item.logs ||= [];
  item.logs.push({ at: now(), step, note });
}

// 领用落账（调用前须先过 judgeWithdrawal）
export function placeWithdrawal(item, { orderNo, amount, operator }) {
  const withdrawal = {
    id: rid("WD"), at: now(),
    orderNo: String(orderNo).trim(), amount: Number(amount),
    operator: String(operator).trim(),
    status: "生效中", sheets: []
  };
  item.withdrawals ||= [];
  item.withdrawals.push(withdrawal);
  log(item, "领用", `订单${withdrawal.orderNo} 领用${withdrawal.amount}kg，经办${withdrawal.operator}，余量${remainingOf(item)}kg`);
  return { withdrawal };
}

// 逐帘存档：成品入成品档；破帘或异物这一帘转返浆
export function archiveSheet(item, withdrawalId, { result, operator }) {
  const withdrawal = (item.withdrawals || []).find(w => w.id === withdrawalId);
  if (!withdrawal || withdrawal.status !== "生效中") return { error: "领用记录不存在或已撤回" };
  if (!["成品", "破帘", "异物"].includes(result)) return { error: "帘结果只能是 成品/破帘/异物" };
  const sheet = { id: rid("SH"), at: now(), result, operator: String(operator || "").trim() };
  withdrawal.sheets ||= [];
  withdrawal.sheets.push(sheet);
  let product = null;
  if (result === "成品") {
    product = { id: rid("PD"), at: now(), withdrawalId, orderNo: withdrawal.orderNo, sheetId: sheet.id, status: "有效" };
    item.products ||= [];
    item.products.push(product);
    log(item, "成品", `订单${withdrawal.orderNo} 一帘成品存档（${product.id}）`);
  } else {
    log(item, "返浆", `订单${withdrawal.orderNo} 一帘${result}，转返浆`);
  }
  return { sheet, product };
}

// 余浆称重回缸：先挂待复核，复核通过前不释放余量
export function recordReturn(item, { withdrawalId, amount, operator }) {
  const value = Number(amount);
  if (!Number.isFinite(value) || value <= 0) return { error: "回缸重量必须是大于 0 的数字" };
  if (!operator || !String(operator).trim()) return { error: "请填写交回人" };
  if (withdrawalId && !(item.withdrawals || []).some(w => w.id === withdrawalId)) {
    return { error: "关联的领用记录不存在" };
  }
  const record = {
    id: rid("RT"), at: now(),
    withdrawalId: withdrawalId || null,
    amount: value, operator: String(operator).trim(),
    status: "待复核", review: null
  };
  item.returns ||= [];
  item.returns.push(record);
  log(item, "回缸", `余浆称重${value}kg回缸，经办${record.operator}，待复核（复核前不释放余量）`);
  return { record };
}

// 回缸复核：必须是另一人，通过后余量释放、领用恢复
export function reviewReturn(item, returnId, reviewer) {
  const record = (item.returns || []).find(r => r.id === returnId);
  if (!record) return { error: "回缸记录不存在" };
  if (record.status !== "待复核") return { error: "该回缸记录不在待复核状态" };
  if (!reviewer || !String(reviewer).trim()) return { error: "请填写复核人" };
  if (String(reviewer).trim() === record.operator) return { error: "复核人必须是另一人，不能由交回人复核" };
  record.status = "已复核";
  record.review = { at: now(), by: String(reviewer).trim() };
  log(item, "复核", `回缸${record.amount}kg 经${record.review.by}复核通过，余量释放为${remainingOf(item)}kg，恢复领用`);
  return { record };
}

// 失效重算：关联成品与余浆记录标记失效，旧记录原样保留进履历，余量按口径自动重算
function invalidateLinked(item, withdrawalIds, reason) {
  const products = (item.products || []).filter(p => p.status === "有效" && withdrawalIds.includes(p.withdrawalId));
  const returns = (item.returns || []).filter(r => r.status !== "已失效" && withdrawalIds.includes(r.withdrawalId));
  if (!products.length && !returns.length) return;
  for (const p of products) p.status = "已失效";
  for (const r of returns) r.status = "已失效";
  item.history ||= [];
  item.history.push({
    at: now(), reason,
    invalidatedProducts: products.map(p => ({ ...p })),
    invalidatedReturns: returns.map(r => ({ ...r }))
  });
  log(item, "失效", `${reason}：成品${products.length}条、余浆${returns.length}条失效重算，旧履历可查`);
}

// 撤回领用：领用作废，关联成品与余浆记录失效重算
export function revokeWithdrawal(item, withdrawalId, operator) {
  const withdrawal = (item.withdrawals || []).find(w => w.id === withdrawalId);
  if (!withdrawal) return { error: "领用记录不存在" };
  if (withdrawal.status === "已撤回") return { error: "该领用已撤回" };
  withdrawal.status = "已撤回";
  withdrawal.revokedAt = now();
  withdrawal.revokedBy = String(operator || "").trim();
  invalidateLinked(item, [withdrawalId], `撤回领用${withdrawalId}（订单${withdrawal.orderNo}）`);
  log(item, "撤回", `撤回领用${withdrawalId}，余量重算为${remainingOf(item)}kg`);
  return { withdrawal };
}

// 改原重量：全部生效领用的关联成品与余浆记录失效重算，旧重量进履历
export function changeWeight(item, newWeight, operator) {
  const value = Number(newWeight);
  if (!Number.isFinite(value) || value < 0) return { error: "原重量必须是不小于 0 的数字" };
  const old = Number(item.weight || 0);
  if (value === old) return { changed: false };
  item.history ||= [];
  item.history.push({ at: now(), reason: "改原重量", oldWeight: old, newWeight: value, by: String(operator || "").trim() });
  item.weight = value;
  const affected = (item.withdrawals || []).filter(w => w.status === "生效中").map(w => w.id);
  invalidateLinked(item, affected, `原重量${old}kg改为${value}kg`);
  log(item, "改重", `原重量${old}kg改为${value}kg，余量重算为${remainingOf(item)}kg`);
  return { changed: true };
}
