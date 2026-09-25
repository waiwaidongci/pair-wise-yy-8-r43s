// 页面动作：页面结构与前端的领用、记帘、回缸、复核、撤回、改重等操作。
// 领用判定在 withdrawal.js，成品存档在 archive.js，这里只发请求、渲染结果。

const stages = ["入缸", "发酵中", "可抄纸", "异常观察"];
const fields = [["code","批次编号","text"],["source","原料来源","text"],["vat","浸泡缸","text"],["days","发酵天数","number"],["owner","负责人","text"],["weight","原重量kg","number"]];
const extraFields = [["temperature","温度"],["smell","气味状态"],["fiber","纤维松散度"],["changedWater","是否换水"],["abnormal","异味或霉点"]];

export function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法纸浆发酵与抄纸记录</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:380px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(280px,1fr)); gap:12px; } .card { display:grid; gap:8px; align-content:start; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:90px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .row { display:flex; gap:6px; flex-wrap:wrap; } .row button { padding:5px 9px; font-size:12px; font-weight:400; }
    .pulp { border-top:1px solid var(--line); padding-top:8px; display:grid; gap:6px; } details { font-size:12px; color:var(--muted); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法纸浆发酵与抄纸记录</h1><div class="meta">纸浆批次、浸泡缸、换水观察、抄纸领用与余浆回缸</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增纸浆批次</h2><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存纸浆批次</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>每日观察记录</h2><label>选择纸浆批次</label><select name="id" id="itemSelect"></select><div id="extraFields"></div><button>提交记录</button></form>
      <form id="withdrawForm" style="margin-top:14px"><h2>抄纸领用（按订单）</h2><label>可抄纸批次</label><select name="id" id="withdrawItem"></select><label>订单号</label><input name="orderNo" required><label>领用量 kg</label><input name="amount" type="number" step="0.001" min="0" required><label>领用人</label><input name="operator" required><button>提交领用</button></form>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>每天记录温度、气味、纤维状态和换水情况；可抄纸批次按订单领用，破帘异物转返浆，余浆称重回缸经复核后恢复领用。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script>
    const fields = ${JSON.stringify(fields)};
    const stages = ${JSON.stringify(stages)};
    const extraFields = ${JSON.stringify(extraFields)};
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const withdrawForm = document.querySelector('#withdrawForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    const withdrawItem = document.querySelector('#withdrawItem');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>').join('');
      document.querySelector('#extraFields').innerHTML = extraFields.map(([key,label]) => '<label>'+label+'</label><input name="'+key+'">').join('');
    }
    function render() {
      itemSelect.innerHTML = items.map(item => '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>').join('');
      const ready = items.filter(i => i.status === '可抄纸');
      withdrawItem.innerHTML = ready.length ? ready.map(i => '<option value="'+(i.id || i.code)+'">'+i.code+' · 余量 '+(i.pulp ? i.pulp.remaining : 0)+'kg'+(i.pulp && i.pulp.locked ? '（待复核暂停）' : '')+'</option>').join('') : '<option value="">暂无可抄纸批次</option>';
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => (!status || item.status === status) && (!q || JSON.stringify(item).includes(q)));
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      bindActions();
    }
    function bindActions() {
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { await api('/api/items/'+sel.dataset.status, { method:'PATCH', body: JSON.stringify({ status: sel.value }) }); await load(); });
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      document.querySelectorAll('[data-sheet]').forEach(btn => btn.onclick = async () => {
        try { await api('/api/items/'+btn.dataset.item+'/withdrawals/'+btn.dataset.wid+'/sheets', { method:'POST', body: JSON.stringify({ result: btn.dataset.sheet }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-return]').forEach(btn => btn.onclick = async () => {
        const amount = prompt('余浆称重回缸（kg）'); if (amount === null) return;
        const operator = prompt('交回人'); if (operator === null) return;
        try { await api('/api/items/'+btn.dataset.item+'/returns', { method:'POST', body: JSON.stringify({ withdrawalId: btn.dataset.return, amount, operator }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-review]').forEach(btn => btn.onclick = async () => {
        const reviewer = prompt('复核人（须为交回人之外的另一人）'); if (reviewer === null) return;
        try { await api('/api/items/'+btn.dataset.item+'/returns/'+btn.dataset.review+'/review', { method:'POST', body: JSON.stringify({ reviewer }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-revoke]').forEach(btn => btn.onclick = async () => {
        const operator = prompt('撤回经办人'); if (operator === null) return;
        if (!confirm('确认撤回该领用？关联成品与余浆记录将失效重算')) return;
        try { await api('/api/items/'+btn.dataset.item+'/withdrawals/'+btn.dataset.revoke+'/revoke', { method:'POST', body: JSON.stringify({ operator }) }); await load(); } catch (e) { alert(e.message); }
      });
      document.querySelectorAll('[data-weight]').forEach(btn => btn.onclick = async () => {
        const weight = prompt('新的原重量（kg），改重会让关联成品与余浆记录失效重算'); if (weight === null) return;
        const operator = prompt('经办人'); if (operator === null) return;
        try { await api('/api/items/'+btn.dataset.weight, { method:'PATCH', body: JSON.stringify({ weight: Number(weight), operator }) }); await load(); } catch (e) { alert(e.message); }
      });
    }
    function pulpHtml(item) {
      const p = item.pulp;
      if (!p || (item.status !== '可抄纸' && !(item.withdrawals || []).length && !(item.returns || []).length)) return '';
      const id = item.id || item.code;
      let html = '<div class="pulp"><div><b>原重量</b> '+p.weight+'kg · <b>已领用</b> '+p.used+'kg · <b>已回缸</b> '+p.returned+'kg · <b>当前余量</b> '+p.remaining+'kg</div>';
      if (p.locked) html += '<div class="warn">有 '+p.pendingReturn+'kg 余浆回缸待复核，复核前暂停领用、不释放余量</div>';
      html += (item.withdrawals || []).map(w => {
        const sheets = w.sheets || [];
        const good = sheets.filter(s => s.result === '成品').length;
        let row = '<div class="meta">领用 '+w.id+' · 订单'+w.orderNo+' · '+w.amount+'kg · '+w.operator+' · '+w.status+' · 成品'+good+'帘 / 返浆'+(sheets.length - good)+'帘</div>';
        if (w.status === '生效中') {
          row += '<div class="row">'
            + '<button data-sheet="成品" data-item="'+id+'" data-wid="'+w.id+'">成品一帘</button>'
            + '<button class="secondary" data-sheet="破帘" data-item="'+id+'" data-wid="'+w.id+'">破帘返浆</button>'
            + '<button class="secondary" data-sheet="异物" data-item="'+id+'" data-wid="'+w.id+'">异物返浆</button>'
            + '<button class="secondary" data-return="'+w.id+'" data-item="'+id+'">余浆回缸</button>'
            + '<button class="secondary" data-revoke="'+w.id+'" data-item="'+id+'">撤回领用</button>'
            + '</div>';
        }
        return row;
      }).join('');
      html += (item.returns || []).map(r => {
        let row = '<div class="meta">回缸 '+r.id+' · '+r.amount+'kg · 交回 '+r.operator+' · '+r.status+(r.review ? '（复核 '+r.review.by+'）' : '')+'</div>';
        if (r.status === '待复核') row += '<div class="row"><button data-review="'+r.id+'" data-item="'+id+'">复核放行</button></div>';
        return row;
      }).join('');
      const products = item.products || [];
      const valid = products.filter(x => x.status === '有效').length;
      html += '<div class="meta">成品存档 '+valid+' 帘（已失效 '+(products.length - valid)+' 帘）</div>';
      html += '<div class="row"><button class="secondary" data-weight="'+id+'">改原重量</button></div>';
      const history = item.history || [];
      const dead = products.filter(x => x.status !== '有效');
      const deadReturns = (item.returns || []).filter(r => r.status === '已失效');
      if (history.length || dead.length || deadReturns.length) {
        html += '<details><summary>旧履历（'+history.length+' 次失效重算）</summary>'
          + history.map(h => '<div>'+h.at+' · '+h.reason+'</div>').join('')
          + dead.map(x => '<div>成品 '+x.id+' · 订单'+x.orderNo+' · 已失效</div>').join('')
          + deadReturns.map(r => '<div>回缸 '+r.id+' · '+r.amount+'kg · 已失效</div>').join('')
          + '</details>';
      }
      return html + '</div>';
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const tasks = (item.tasks || []).map(t => '<div class="meta">任务 '+t.position+' · '+t.status+' · '+t.tension+'</div>').join('');
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      return '<article class="card"><h3>'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span>'+main+tasks+pulpHtml(item)+'<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() { items = await api('/api/items'); render(); }
    createForm.onsubmit = async event => { event.preventDefault(); await api('/api/items', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(createForm).entries())) }); createForm.reset(); await load(); };
    actionForm.onsubmit = async event => { event.preventDefault(); await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(Object.fromEntries(new FormData(actionForm).entries())) }); actionForm.reset(); await load(); };
    withdrawForm.onsubmit = async event => {
      event.preventDefault();
      const fd = Object.fromEntries(new FormData(withdrawForm).entries());
      if (!fd.id) { alert('暂无可抄纸批次'); return; }
      try { await api('/api/items/'+fd.id+'/withdrawals', { method:'POST', body: JSON.stringify(fd) }); withdrawForm.reset(); await load(); } catch (e) { alert(e.message); }
    };
    document.querySelector('#statusFilter').onchange = render; document.querySelector('#search').oninput = render; document.querySelector('#reload').onclick = load;
    renderForms(); load();
  </script>
</body>
</html>`;
}
