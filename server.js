import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { archiveProduct } from "./lib/archive.js";
import { batchKey, cancelWithdrawal, changePulpWeight, createStockReturn, createWithdrawal, findBatch, pulpSummary, reviewReturn } from "./lib/withdrawal.js";

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
    }
  ]
};
const stages = ["入缸","发酵中","可抄纸","异常观察"];
const statLabels = ["入缸","发酵中","可抄纸","异常观察"];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  const db = JSON.parse(await readFile(dbPath, "utf8"));
  db.items ||= [];
  db.withdrawals ||= [];
  db.products ||= [];
  db.returns ||= [];
  return db;
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
  return { ...item, logCount };
}
function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 8px; font-size:15px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; } button.tiny { padding:4px 8px; font-size:12px; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .paperroom,.paperlists,.historygrid { display:grid; grid-template-columns:repeat(auto-fit,minmax(240px,1fr)); gap:12px; }
    .paperlists,#historyPanel { margin-top:12px; }
    .record { border-top:1px solid var(--line); padding:6px 0; font-size:13px; }
    .actions { display:flex; gap:6px; flex-wrap:wrap; margin-top:4px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵记录</h1><div class="meta">纸浆批次、浸泡缸、发酵观察、抄纸领用与余浆回缸</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况，系统统计发酵进度与异常次数。</h2><div class="grid" id="cards"></div></div>
    </section>
    <section class="panel" style="grid-column:1/-1">
      <h2>抄纸房 · 按订单领用与余浆回缸</h2>
      <div class="paperroom">
        <form id="withdrawForm"><h3>抄纸领用</h3><label>可抄纸批次</label><select name="batchId" id="wdBatch"></select><label>订单号</label><input name="orderNo" required><label>领用重量(kg)</label><input name="amount" type="number" step="0.1" min="0.1" required><label>领用人</label><input name="by"><button>按订单领用</button></form>
        <form id="productForm"><h3>成品存档</h3><label>领用记录</label><select name="withdrawalId" id="pdWithdrawal"></select><label>成品帘数</label><input name="sheets" type="number" min="1" required><label>破帘数</label><input name="broken" type="number" min="0" value="0"><label>异物帘数</label><input name="foreign" type="number" min="0" value="0"><label>返浆重量(kg)</label><input name="defectPulp" type="number" step="0.1" min="0" value="0"><label>存档人</label><input name="by"><button>成品存档</button></form>
        <form id="returnForm"><h3>余浆回缸</h3><label>原批次</label><select name="batchId" id="rtBatch"></select><label>称重重量(kg)</label><input name="amount" type="number" step="0.1" min="0.1" required><label>余浆去向批次</label><select name="targetBatchId" id="rtTarget"></select><label>交回人</label><input name="by" required><button>称重回缸</button></form>
      </div>
      <div class="paperlists">
        <div><h3>领用记录</h3><div id="withdrawalList"></div></div>
        <div><h3>成品记录</h3><div id="productList"></div></div>
        <div><h3>回缸记录（待复核须另一人复核）</h3><div id="returnList"></div></div>
      </div>
      <div id="historyPanel"></div>
    </section>
  </main>
  <script>
    const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"],["pulpWeight","原重量(kg)","number"]];
    const stages = ["入缸","发酵中","可抄纸","异常观察"];
    const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];
    const errText = { insufficient_remaining:'超过当前余量，已保留原记录并拒绝', batch_not_ready:'批次未进入可抄纸，不能领用', order_required:'请填写订单号', amount_invalid:'重量无效', sheets_invalid:'帘数无效', defects_invalid:'破帘/异物数量无效', defect_pulp_required:'破帘或异物须填写返浆重量', withdrawal_not_found:'领用记录不存在', withdrawal_not_active:'领用记录已撤回', return_not_pending:'该回缸记录不在待复核状态', reviewer_required:'请填写复核人', reviewer_must_differ:'须另一人复核', return_by_required:'请填写交回人', target_not_found:'去向批次不存在', weight_invalid:'原重量无效', item_not_found:'批次不存在' };
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const withdrawForm = document.querySelector('#withdrawForm');
    const productForm = document.querySelector('#productForm');
    const returnForm = document.querySelector('#returnForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const wdBatch = document.querySelector('#wdBatch');
    const pdWithdrawal = document.querySelector('#pdWithdrawal');
    const rtBatch = document.querySelector('#rtBatch');
    const rtTarget = document.querySelector('#rtTarget');
    const withdrawalList = document.querySelector('#withdrawalList');
    const productList = document.querySelector('#productList');
    const returnList = document.querySelector('#returnList');
    const historyPanel = document.querySelector('#historyPanel');
    let items = [], withdrawals = [], products = [], returnsList = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(errText[data.error] || data.error || '请求失败');
      return data;
    }
    function keyOf(item) { return item.id || item.code; }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      const ready = items.filter(i => i.status === '可抄纸');
      const readyOpts = ready.map(i => '<option value="'+keyOf(i)+'">'+(i.code || i.id)+' · 余量'+(i.pulp ? i.pulp.remaining : 0)+'kg</option>').join('');
      wdBatch.innerHTML = readyOpts;
      rtBatch.innerHTML = readyOpts;
      rtTarget.innerHTML = items.map(i => '<option value="'+keyOf(i)+'">'+(i.code || i.id)+'</option>').join('');
      if (rtBatch.value) rtTarget.value = rtBatch.value;
      pdWithdrawal.innerHTML = withdrawals.filter(w => w.status === '有效').map(w => '<option value="'+w.id+'">'+w.id+' · '+w.batchId+' · 订单'+w.orderNo+' · '+w.amount+'kg</option>').join('');
      withdrawalList.innerHTML = withdrawals.map(w => '<div class="record">'+w.id+' · 批次'+w.batchId+' · 订单'+w.orderNo+' · '+w.amount+'kg · '+(w.by || '—')+' <span class="pill">'+w.status+'</span>'+(w.status==='已撤回' ? '<div class="meta">撤回：'+(w.cancelReason || '')+' '+(w.cancelBy || '')+'</div>' : '')+(w.status==='有效' ? '<div class="actions"><button class="secondary tiny" data-cancel="'+w.id+'">撤回领用</button></div>' : '')+'</div>').join('') || '<div class="record">暂无领用记录</div>';
      productList.innerHTML = products.map(p => '<div class="record">'+p.id+' · 订单'+p.orderNo+' · '+p.sheets+'帘（好'+p.goodSheets+' 破'+p.broken+' 异'+p.foreign+'）· 返浆'+p.defectPulp+'kg · '+(p.by || '—')+' <span class="pill">'+p.status+'</span>'+(p.invalidateReason ? '<div class="meta">失效：'+p.invalidateReason+'</div>' : '')+'</div>').join('') || '<div class="record">暂无成品记录</div>';
      returnList.innerHTML = returnsList.map(r => '<div class="record">'+r.id+' · '+r.source+' · '+r.amount+'kg · '+r.batchId+' → '+r.targetBatchId+' · 交回'+(r.by || '—')+' <span class="pill">'+r.status+'</span>'+(r.reviewedBy ? '<div class="meta">复核 '+r.reviewedBy+'</div>' : '')+(r.invalidateReason ? '<div class="meta">失效：'+r.invalidateReason+'</div>' : '')+(r.status==='待复核' ? '<div class="actions"><button class="secondary tiny" data-review="'+r.id+'">复核</button></div>' : '')+'</div>').join('') || '<div class="record">暂无回缸记录</div>';
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-cancel]').forEach(btn => btn.onclick = async () => {
        const reason = prompt('撤回原因'); if (reason === null) return;
        const by = prompt('操作人') || '';
        try { await api('/api/withdrawals/'+btn.dataset.cancel+'/cancel', { method:'POST', body: JSON.stringify({ reason, by }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = async () => {
        const reviewedBy = prompt('复核人（须与交回人不同）'); if (!reviewedBy) return;
        try { await api('/api/returns/'+btn.dataset.review+'/review', { method:'POST', body: JSON.stringify({ reviewedBy }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-weight]').forEach(btn => btn.onclick = async () => {
        const w = prompt('新的原重量(kg)'); if (w === null || w === '') return;
        const by = prompt('操作人') || '';
        try { await api('/api/items/'+btn.dataset.weight+'/weight', { method:'PATCH', body: JSON.stringify({ pulpWeight: Number(w), by }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-history]').forEach(btn => btn.onclick = async () => {
        try { const h = await api('/api/items/'+btn.dataset.history+'/history'); historyPanel.innerHTML = historyHtml(h); historyPanel.scrollIntoView({ behavior:'smooth' }); } catch (e) { alert(e.message); }
      });
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const pulp = item.pulp ? '<div class="meta">原重'+(item.pulp.pulpWeight || 0)+'kg · 已领'+item.pulp.used+'kg · 已回'+item.pulp.returned+'kg · 待复核'+item.pulp.pending+'kg · <b>余量'+item.pulp.remaining+'kg</b></div>' : '';
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+pulp+tasks+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><div class="actions"><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><button class="secondary" data-weight="'+(item.id || item.code)+'">改原重量</button><button class="secondary" data-history="'+(item.id || item.code)+'">履历</button></div><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    function historyHtml(h) {
      const w = h.withdrawals.map(x => '<div class="record">'+x.id+' · 订单'+x.orderNo+' · '+x.amount+'kg · '+(x.by || '—')+' <span class="pill">'+x.status+'</span>'+(x.status==='已撤回' ? '<div class="meta">撤回：'+(x.cancelReason || '')+' '+(x.cancelBy || '')+'</div>' : '')+'</div>').join('');
      const p = h.products.map(x => '<div class="record">'+x.id+' · 订单'+x.orderNo+' · '+x.sheets+'帘（好'+x.goodSheets+' 破'+x.broken+' 异'+x.foreign+'）· 返浆'+x.defectPulp+'kg <span class="pill">'+x.status+'</span>'+(x.invalidateReason ? '<div class="meta">失效：'+x.invalidateReason+'</div>' : '')+'</div>').join('');
      const r = h.returns.map(x => '<div class="record">'+x.id+' · '+x.source+' · '+x.amount+'kg · 去向'+x.targetBatchId+' · 交回'+(x.by || '—')+' <span class="pill">'+x.status+'</span>'+(x.reviewedBy ? '<div class="meta">复核 '+x.reviewedBy+'</div>' : '')+(x.invalidateReason ? '<div class="meta">失效：'+x.invalidateReason+'</div>' : '')+'</div>').join('');
      const logs = h.logs.map(l => '<div class="record">'+(l.at || '').slice(0,19)+' · '+l.step+' · '+l.note+'</div>').join('');
      return '<h3>履历 · '+(h.item.code || h.item.id)+'（当前余量 '+h.pulp.remaining+'kg）</h3><div class="historygrid"><div><h3>领用</h3>'+(w || '<div class="record">无</div>')+'</div><div><h3>成品</h3>'+(p || '<div class="record">无</div>')+'</div><div><h3>余浆回缸</h3>'+(r || '<div class="record">无</div>')+'</div><div><h3>批次日志</h3>'+(logs || '<div class="record">无</div>')+'</div></div>';
    }
    async function load() {
      const [its, wds, pds, rts] = await Promise.all([api('/api/items'), api('/api/withdrawals'), api('/api/products'), api('/api/returns')]);
      items = its; withdrawals = wds; products = pds; returnsList = rts;
      render();
    }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    withdrawForm.onsubmit = async event => {
      event.preventDefault();
      const f = new FormData(withdrawForm);
      if (!f.get('batchId')) return alert('暂无可抄纸批次');
      try { await api('/api/items/'+f.get('batchId')+'/withdrawals', { method:'POST', body: JSON.stringify({ orderNo:f.get('orderNo'), amount:f.get('amount'), by:f.get('by') }) }); withdrawForm.reset(); await load(); } catch (e) { alert(e.message); }
    };
    productForm.onsubmit = async event => {
      event.preventDefault();
      const f = new FormData(productForm);
      if (!f.get('withdrawalId')) return alert('暂无有效领用记录');
      try { await api('/api/withdrawals/'+f.get('withdrawalId')+'/products', { method:'POST', body: JSON.stringify({ sheets:f.get('sheets'), broken:f.get('broken'), foreign:f.get('foreign'), defectPulp:f.get('defectPulp'), by:f.get('by') }) }); productForm.reset(); await load(); } catch (e) { alert(e.message); }
    };
    returnForm.onsubmit = async event => {
      event.preventDefault();
      const f = new FormData(returnForm);
      if (!f.get('batchId')) return alert('暂无可抄纸批次');
      try { await api('/api/items/'+f.get('batchId')+'/returns', { method:'POST', body: JSON.stringify({ amount:f.get('amount'), targetBatchId:f.get('targetBatchId'), by:f.get('by') }) }); returnForm.reset(); await load(); } catch (e) { alert(e.message); }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const db = await loadDb();
    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") return send(res, 200, db.items.map(item => ({ ...summarize(item), pulp: pulpSummary(db, item) })));
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      const item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建纸浆批次" }] };

      db.items.unshift(item);
      await saveDb(db);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = findBatch(db, patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const { pulpWeight, by, ...rest } = input;
      if (pulpWeight !== undefined) {
        const result = changePulpWeight(db, item, { pulpWeight, by });
        if (result.error) return send(res, result.status, result);
      }
      Object.assign(item, rest);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = findBatch(db, log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = findBatch(db, action[1]);
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
    // 抄纸领用：按订单领用，超过当前余量保留原记录并拒绝
    const withdraw = url.pathname.match(/^\/api\/items\/([^/]+)\/withdrawals$/);
    if (withdraw && req.method === "POST") {
      const item = findBatch(db, withdraw[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const result = createWithdrawal(db, item, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    // 余浆回缸：称重回缸，待复核，复核前不释放余量
    const stockReturn = url.pathname.match(/^\/api\/items\/([^/]+)\/returns$/);
    if (stockReturn && req.method === "POST") {
      const item = findBatch(db, stockReturn[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const result = createStockReturn(db, item, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    // 改原重量：关联成品和余浆记录失效重算
    const weight = url.pathname.match(/^\/api\/items\/([^/]+)\/weight$/);
    if (weight && req.method === "PATCH") {
      const item = findBatch(db, weight[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const result = changePulpWeight(db, item, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    // 旧履历：含已撤回领用、已失效成品与余浆记录
    const history = url.pathname.match(/^\/api\/items\/([^/]+)\/history$/);
    if (history && req.method === "GET") {
      const item = findBatch(db, history[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const key = batchKey(item);
      return send(res, 200, {
        item: summarize(item),
        pulp: pulpSummary(db, item),
        withdrawals: db.withdrawals.filter(w => w.batchId === key),
        products: db.products.filter(p => p.batchId === key),
        returns: db.returns.filter(r => r.batchId === key || r.targetBatchId === key),
        logs: item.logs || []
      });
    }
    if (req.method === "GET" && url.pathname === "/api/withdrawals") {
      const batch = url.searchParams.get("batch");
      return send(res, 200, db.withdrawals.filter(w => !batch || w.batchId === batch));
    }
    // 撤回领用：关联成品和余浆记录失效重算
    const cancel = url.pathname.match(/^\/api\/withdrawals\/([^/]+)\/cancel$/);
    if (cancel && req.method === "POST") {
      const withdrawal = db.withdrawals.find(x => x.id === cancel[1]);
      if (!withdrawal) return send(res, 404, { error: "withdrawal_not_found" });
      const result = cancelWithdrawal(db, withdrawal, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    // 成品存档：登记帘数，破帘/异物转返浆
    const wdProduct = url.pathname.match(/^\/api\/withdrawals\/([^/]+)\/products$/);
    if (wdProduct && req.method === "POST") {
      const withdrawal = db.withdrawals.find(x => x.id === wdProduct[1]);
      if (!withdrawal) return send(res, 404, { error: "withdrawal_not_found" });
      if (withdrawal.status !== "有效") return send(res, 409, { error: "withdrawal_not_active" });
      const result = archiveProduct(db, withdrawal, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    if (req.method === "GET" && url.pathname === "/api/products") {
      const batch = url.searchParams.get("batch");
      return send(res, 200, db.products.filter(p => !batch || p.batchId === batch));
    }
    if (req.method === "GET" && url.pathname === "/api/returns") {
      const batch = url.searchParams.get("batch");
      return send(res, 200, db.returns.filter(r => !batch || r.batchId === batch || r.targetBatchId === batch));
    }
    // 回缸复核：另一人复核后才释放余量恢复领用
    const review = url.pathname.match(/^\/api\/returns\/([^/]+)\/review$/);
    if (review && req.method === "POST") {
      const record = db.returns.find(x => x.id === review[1]);
      if (!record) return send(res, 404, { error: "not_found" });
      const result = reviewReturn(db, record, await body(req));
      await saveDb(db);
      return send(res, result.status, result);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法纸浆发酵记录 listening on http://localhost:" + port));
