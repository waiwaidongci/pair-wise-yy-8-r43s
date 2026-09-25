# 古法纸浆发酵与抄纸记录

运行：

```bash
npm start
```

访问`http://localhost:3039`。数据保存在`data/paper-pulp-fermentation.json`。

## 抄纸领用与余浆回缸

批次进入「可抄纸」后按订单领用纸浆，全程留痕替代口头交接：

- **领用**：`POST /api/items/:id/withdrawals`（订单号、领用量、领用人）。领用量超过当前余量时返回 409，原记录不变。
- **记帘**：`POST /api/items/:id/withdrawals/:wid/sheets`，`result` 为 `成品`（入成品档）或 `破帘`/`异物`（该帘转返浆）。
- **余浆回缸**：`POST /api/items/:id/returns`，称重登记后挂「待复核」，复核前不释放余量、暂停该批次领用。
- **复核**：`POST /api/items/:id/returns/:rid/review`，复核人必须是交回人之外的另一人；通过后余量释放、恢复领用。
- **撤回领用**：`POST /api/items/:id/withdrawals/:wid/revoke`，关联成品与余浆记录失效并重算余量。
- **改原重量**：`PATCH /api/items/:id` 带 `weight`，关联成品与余浆记录失效重算，旧重量入履历。
- **旧履历**：`GET /api/items/:id/history` 可查失效重算记录与旧快照。

余量口径：当前余量 = 原重量 − 生效领用 + 已复核回缸（待复核回缸不计入）。

## 代码结构

业务分三处，HTTP 路由只做接线：

- `src/withdrawal.js` — 领用判定（余量口径、超量/冻结拒绝，纯函数不改数据）
- `src/archive.js` — 成品存档（领用落账、逐帘存档、回缸与复核、失效重算、旧履历）
- `src/page.js` — 页面动作（页面结构与前端交互）
- `server.js` — HTTP 路由与持久化
