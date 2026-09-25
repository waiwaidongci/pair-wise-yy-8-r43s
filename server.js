import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { judgeWithdrawal, pulpSummary } from "./src/withdrawal.js";
import { placeWithdrawal, archiveSheet, recordReturn, reviewReturn, revokeWithdrawal, changeWeight } from "./src/archive.js";
import { page } from "./src/page.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "paper-pulp-fermentation.json");
const port = Number(process.env.PORT || 3039);
const seed = {
  "items": [
    {
      "code": "PF-001",
      "source": "构树皮",
      "vat": "三号缸",
      "days": 5,
      "owner": "林素",
      "status": "发酵中",
      "logs": [
        {
          "at": "2026-06-15",
          "step": "观察",
          "note": "温度24.6，气味微酸，纤维开始松散",
          "abnormal": false
        }
      ]
    },
    {
      "code": "PF-002",
      "source": "楮皮",
      "vat": "一号缸",
      "days": 9,
      "owner": "林素",
      "weight": 120,
      "status": "可抄纸",
      "logs": [
        {
          "at": "2026-06-10",
          "step": "状态",
          "note": "发酵完成，原重量120kg，转可抄纸"
        }
      ]
    }
  ]
};
const statLabels = ["入缸", "发酵中", "可抄纸", "异常观察"];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "PF-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
function summarize(item) {
  const logCount = (item.logs || []).length + (item.tasks || []).reduce((n, t) => n + (t.logs || []).length, 0);
  return { ...item, logCount, pulp: pulpSummary(item) };
}
function findItem(db, key) {
  return db.items.find(x => x.id === key || x.code === key);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(summarize));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }] };

      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findItem(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      if (input.weight !== undefined) {
        const result = changeWeight(item, input.weight, input.operator);
        if (result.error) return send(res, 400, result);
      }
      delete input.weight;
      delete input.operator;
      Object.assign(item, input);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findItem(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findItem(db, action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      const abnormal = String(input.abnormal || "").includes("是") || String(input.abnormal || "").includes("有");
      item.observations ||= [];
      item.observations.push({ at: new Date().toISOString(), ...input, abnormal });
      item.days = Number(item.days || 0) + 1;
      item.status = abnormal ? "异常观察" : Number(item.days) >= 7 ? "可抄纸" : "发酵中";
      item.logs.push({ at: new Date().toISOString(), step: "观察", note: "温度" + (input.temperature || "") + "，" + (input.smell || "") + "，" + (input.fiber || "") });
      await saveDb(db);
      return send(res, 201, item);
    }
    // 抄纸领用：先过领用判定，拒绝则原记录不动
    const withdraw = url.pathname.match(/^\/api\/items\/([^/]+)\/withdrawals$/);
    if (withdraw && req.method === "POST") {
      const item = findItem(db, withdraw[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const verdict = judgeWithdrawal(item, input);
      if (!verdict.ok) return send(res, 409, { error: verdict.reason });
      const { withdrawal } = placeWithdrawal(item, input);
      await saveDb(db);
      return send(res, 201, { withdrawal, pulp: pulpSummary(item) });
    }
    // 逐帘存档：成品入档，破帘/异物转返浆
    const sheet = url.pathname.match(/^\/api\/items\/([^/]+)\/withdrawals\/([^/]+)\/sheets$/);
    if (sheet && req.method === "POST") {
      const item = findItem(db, sheet[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const result = archiveSheet(item, sheet[2], await body(req));
      if (result.error) return send(res, 400, result);
      await saveDb(db);
      return send(res, 201, result);
    }
    // 撤回领用：关联成品与余浆记录失效重算
    const revoke = url.pathname.match(/^\/api\/items\/([^/]+)\/withdrawals\/([^/]+)\/revoke$/);
    if (revoke && req.method === "POST") {
      const item = findItem(db, revoke[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const result = revokeWithdrawal(item, revoke[2], input.operator);
      if (result.error) return send(res, 400, result);
      await saveDb(db);
      return send(res, 200, { ...result, pulp: pulpSummary(item) });
    }
    // 余浆称重回缸：挂待复核，复核前不释放余量
    const ret = url.pathname.match(/^\/api\/items\/([^/]+)\/returns$/);
    if (ret && req.method === "POST") {
      const item = findItem(db, ret[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const result = recordReturn(item, await body(req));
      if (result.error) return send(res, 400, result);
      await saveDb(db);
      return send(res, 201, { ...result, pulp: pulpSummary(item) });
    }
    // 回缸复核：须另一人，通过后释放余量、恢复领用
    const review = url.pathname.match(/^\/api\/items\/([^/]+)\/returns\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const item = findItem(db, review[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const result = reviewReturn(item, review[2], input.reviewer);
      if (result.error) return send(res, 400, result);
      await saveDb(db);
      return send(res, 200, { ...result, pulp: pulpSummary(item) });
    }
    // 旧履历：失效重算记录与旧快照可查
    const history = url.pathname.match(/^\/api\/items\/([^/]+)\/history$/);
    if (history && req.method === "GET") {
      const item = findItem(db, history[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      return send(res, 200, {
        history: item.history || [],
        products: item.products || [],
        returns: item.returns || [],
        withdrawals: item.withdrawals || []
      });
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵与抄纸记录 listening on http://localhost:" + port));
