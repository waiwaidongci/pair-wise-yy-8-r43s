// 领用判定：只判断“能不能领、还剩多少”，不改动任何数据。
// 余量口径：当前余量 = 原重量 - 生效领用 + 已复核回缸；待复核回缸不释放余量。

export function activeWithdrawals(item) {
  return (item.withdrawals || []).filter(w => w.status !== "已撤回");
}

export function pendingReturns(item) {
  return (item.returns || []).filter(r => r.status === "待复核");
}

export function reviewedReturns(item) {
  return (item.returns || []).filter(r => r.status === "已复核");
}

export function usedAmount(item) {
  return activeWithdrawals(item).reduce((sum, w) => sum + Number(w.amount || 0), 0);
}

export function returnedAmount(item) {
  return reviewedReturns(item).reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

export function pendingReturnAmount(item) {
  return pendingReturns(item).reduce((sum, r) => sum + Number(r.amount || 0), 0);
}

export function remainingOf(item) {
  const remaining = Number(item.weight || 0) - usedAmount(item) + returnedAmount(item);
  return Math.round(remaining * 1000) / 1000;
}

// 有待复核的余浆回缸时冻结领用，经另一人复核后才恢复
export function withdrawalLocked(item) {
  return pendingReturns(item).length > 0;
}

export function pulpSummary(item) {
  return {
    weight: Number(item.weight || 0),
    used: usedAmount(item),
    returned: returnedAmount(item),
    pendingReturn: pendingReturnAmount(item),
    remaining: remainingOf(item),
    locked: withdrawalLocked(item)
  };
}

// 判定一笔领用：超量、冻结、状态不符都拒绝，调用方收到拒绝后保留原记录不写库
export function judgeWithdrawal(item, input) {
  const amount = Number(input.amount);
  if (item.status !== "可抄纸") return { ok: false, reason: "批次不在可抄纸状态，不能领用" };
  if (!input.orderNo || !String(input.orderNo).trim()) return { ok: false, reason: "领用必须按订单，填写订单号" };
  if (!input.operator || !String(input.operator).trim()) return { ok: false, reason: "请填写领用人" };
  if (!Number.isFinite(amount) || amount <= 0) return { ok: false, reason: "领用量必须是大于 0 的数字" };
  if (withdrawalLocked(item)) return { ok: false, reason: "存在待复核的余浆回缸，复核通过前暂停领用" };
  const remaining = remainingOf(item);
  if (amount > remaining) {
    return { ok: false, reason: `领用 ${amount}kg 超过当前余量 ${remaining}kg，已拒绝并保留原记录`, remaining };
  }
  return { ok: true, remaining };
}
