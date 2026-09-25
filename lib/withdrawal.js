// 领用判定：可抄纸批次按订单领用、余量计算、余浆回缸复核、撤回/改原重量后的失效重算
import { invalidateProducts, invalidateReturns, newReturn, rid } from "./archive.js";

const now = () => new Date().toISOString();

export function batchKey(item) { return item.id || item.code; }

export function findBatch(db, key) {
  return (db.items || []).find(x => x.id === key || x.code === key);
}

function sum(list, predicate) {
  return (list || []).filter(predicate).reduce((total, x) => total + Number(x.amount || 0), 0);
}

// 余量 = 原重量 - 有效领用 + 已复核回缸；待复核的回缸不释放余量
export function computeRemaining(db, item) {
  const key = batchKey(item);
  const used = sum(db.withdrawals, w => w.batchId === key && w.status === "有效");
  const returned = sum(db.returns, r => r.targetBatchId === key && r.status === "已复核");
  return Math.round((Number(item.pulpWeight || 0) - used + returned) * 1000) / 1000;
}

export function pulpSummary(db, item) {
  const key = batchKey(item);
  return {
    pulpWeight: Number(item.pulpWeight || 0),
    used: sum(db.withdrawals, w => w.batchId === key && w.status === "有效"),
    returned: sum(db.returns, r => r.targetBatchId === key && r.status === "已复核"),
    pending: sum(db.returns, r => r.targetBatchId === key && r.status === "待复核"),
    remaining: computeRemaining(db, item)
  };
}

function log(item, step, note) {
  item.logs ||= [];
  item.logs.push({ at: now(), step, note });
}

// 按订单领用：超过当前余量就保留原记录并拒绝
export function createWithdrawal(db, item, input) {
  if (item.status !== "可抄纸") return { status: 409, error: "batch_not_ready" };
  const orderNo = String(input.orderNo || "").trim();
  if (!orderNo) return { status: 400, error: "order_required" };
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { status: 400, error: "amount_invalid" };
  const remaining = computeRemaining(db, item);
  if (amount > remaining) {
    log(item, "领用被拒", "订单" + orderNo + " 领用" + amount + "kg 超过当前余量" + remaining + "kg，保留原记录并拒绝");
    return { status: 409, error: "insufficient_remaining", remaining };
  }
  const withdrawal = {
    id: rid("WD"),
    batchId: batchKey(item),
    orderNo,
    amount,
    by: input.by || "",
    at: now(),
    status: "有效",
    canceledAt: null,
    cancelBy: null,
    cancelReason: null
  };
  db.withdrawals ||= [];
  db.withdrawals.unshift(withdrawal);
  log(item, "领用", "订单" + orderNo + " 领用" + amount + "kg，余量" + computeRemaining(db, item) + "kg");
  return { status: 201, withdrawal };
}

// 撤回领用：关联成品和余浆记录失效，余量重算，旧履历保留可查
export function cancelWithdrawal(db, withdrawal, input) {
  if (withdrawal.status !== "有效") return { status: 409, error: "withdrawal_not_active" };
  withdrawal.status = "已撤回";
  withdrawal.canceledAt = now();
  withdrawal.cancelBy = input.by || "";
  withdrawal.cancelReason = input.reason || "";
  const products = invalidateProducts(db, p => p.withdrawalId === withdrawal.id, "领用撤回");
  const returns = invalidateReturns(db, r => r.withdrawalId === withdrawal.id, "领用撤回");
  const item = findBatch(db, withdrawal.batchId);
  if (item) log(item, "撤回领用", "撤回" + withdrawal.id + "（订单" + withdrawal.orderNo + "），" + products + "条成品、" + returns + "条余浆记录失效，重算余量" + computeRemaining(db, item) + "kg");
  return { status: 200, withdrawal };
}

// 改原重量：关联成品和余浆记录失效，余量重算
export function changePulpWeight(db, item, input) {
  const pulpWeight = Number(input.pulpWeight);
  if (!Number.isFinite(pulpWeight) || pulpWeight < 0) return { status: 400, error: "weight_invalid" };
  const key = batchKey(item);
  const old = Number(item.pulpWeight || 0);
  item.pulpWeight = pulpWeight;
  const products = invalidateProducts(db, p => p.batchId === key, "原重量变更");
  const returns = invalidateReturns(db, r => r.batchId === key || r.targetBatchId === key, "原重量变更");
  log(item, "改原重量", "原重量" + old + "kg改为" + pulpWeight + "kg（" + (input.by || "未署名") + "），" + products + "条成品、" + returns + "条余浆记录失效，重算余量" + computeRemaining(db, item) + "kg");
  return { status: 200, item };
}

// 余浆回缸：剩余浆称重记录去向批次，复核前不释放余量
export function createStockReturn(db, item, input) {
  const amount = Number(input.amount);
  if (!Number.isFinite(amount) || amount <= 0) return { status: 400, error: "amount_invalid" };
  const by = String(input.by || "").trim();
  if (!by) return { status: 400, error: "return_by_required" };
  let target = item;
  if (input.targetBatchId) {
    target = findBatch(db, input.targetBatchId);
    if (!target) return { status: 404, error: "target_not_found" };
  }
  const record = newReturn({ batchId: batchKey(item), targetBatchId: batchKey(target), withdrawalId: input.withdrawalId || null, source: "余浆", amount, by });
  db.returns ||= [];
  db.returns.unshift(record);
  log(item, "余浆回缸", "称重" + amount + "kg 回到" + (target.code || target.id) + "，待复核，复核前不释放余量");
  return { status: 201, record };
}

// 回缸复核：须另一人复核，通过后才释放余量恢复领用
export function reviewReturn(db, record, input) {
  if (record.status !== "待复核") return { status: 409, error: "return_not_pending" };
  const reviewedBy = String(input.reviewedBy || "").trim();
  if (!reviewedBy) return { status: 400, error: "reviewer_required" };
  if (reviewedBy === record.by) return { status: 409, error: "reviewer_must_differ" };
  record.status = "已复核";
  record.reviewedBy = reviewedBy;
  record.reviewedAt = now();
  const target = findBatch(db, record.targetBatchId);
  if (target) log(target, "回缸复核", record.id + " 由" + reviewedBy + "复核，释放" + record.amount + "kg，余量" + computeRemaining(db, target) + "kg");
  return { status: 200, record };
}
