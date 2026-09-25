// 成品存档：抄纸成品登记、破帘/异物转返浆、关联记录失效与重算
const now = () => new Date().toISOString();

export function rid(prefix) {
  return prefix + "-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

// 回缸记录：余浆（剩余称重回缸）或返浆（破帘/异物转返浆）
export function newReturn({ batchId, targetBatchId, withdrawalId = null, productId = null, source, amount, by }) {
  return {
    id: rid("RT"),
    batchId,                                 // 原批次：浆从哪个批次来
    targetBatchId: targetBatchId || batchId, // 余浆去了哪批，默认回到原批次
    withdrawalId,
    productId,
    source,
    amount: Number(amount),
    by: by || "",
    at: now(),
    status: "待复核", // 待复核 → 已复核；关联领用撤回或改原重量 → 已失效
    reviewedBy: null,
    reviewedAt: null,
    invalidatedAt: null,
    invalidateReason: null
  };
}

// 成品存档：登记一笔领用做出的帘数，破帘或异物的帘转返浆
export function archiveProduct(db, withdrawal, input) {
  const sheets = Number(input.sheets);
  const broken = Number(input.broken || 0);
  const foreign = Number(input.foreign || 0);
  const defectPulp = Number(input.defectPulp || 0);
  if (!Number.isInteger(sheets) || sheets <= 0) return { status: 400, error: "sheets_invalid" };
  if (!Number.isInteger(broken) || !Number.isInteger(foreign) || broken < 0 || foreign < 0 || broken + foreign > sheets) {
    return { status: 400, error: "defects_invalid" };
  }
  if (defectPulp < 0 || (broken + foreign > 0 && !(defectPulp > 0))) return { status: 400, error: "defect_pulp_required" };
  const product = {
    id: rid("PD"),
    withdrawalId: withdrawal.id,
    batchId: withdrawal.batchId,
    orderNo: withdrawal.orderNo,
    sheets,
    goodSheets: sheets - broken - foreign,
    broken,
    foreign,
    defectPulp,
    by: input.by || "",
    at: now(),
    status: "有效",
    invalidatedAt: null,
    invalidateReason: null
  };
  db.products ||= [];
  db.products.unshift(product);
  let defectReturn = null;
  if (broken + foreign > 0) {
    defectReturn = newReturn({ batchId: withdrawal.batchId, withdrawalId: withdrawal.id, productId: product.id, source: "返浆", amount: defectPulp, by: input.by });
    db.returns ||= [];
    db.returns.unshift(defectReturn);
  }
  return { status: 201, product, defectReturn };
}

// 关联记录失效：旧记录保留可查，仅标记状态，余量由有效记录重算
export function invalidateProducts(db, predicate, reason) {
  const at = now();
  let count = 0;
  for (const product of db.products || []) {
    if (product.status === "有效" && predicate(product)) {
      product.status = "已失效";
      product.invalidatedAt = at;
      product.invalidateReason = reason;
      count += 1;
    }
  }
  return count;
}

export function invalidateReturns(db, predicate, reason) {
  const at = now();
  let count = 0;
  for (const record of db.returns || []) {
    if (record.status !== "已失效" && predicate(record)) {
      record.status = "已失效";
      record.invalidatedAt = at;
      record.invalidateReason = reason;
      count += 1;
    }
  }
  return count;
}
