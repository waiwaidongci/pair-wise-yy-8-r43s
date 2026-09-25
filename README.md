# 古法纸浆发酵记录

运行：

```bash
npm start
```

访问`http://localhost:3039`。数据保存在`data/paper-pulp-fermentation.json`。

## 抄纸领用与余浆回缸

批次进入「可抄纸」后，在页面下方「抄纸房」按订单领用、登记成品、余浆称重回缸：

- **按订单领用**：领用量超过当前余量时保留原记录并拒绝（HTTP 409），批次日志留「领用被拒」审计记录。
- **成品存档**：登记一笔记领用做出的帘数；破帘或异物的帘转返浆，生成待复核的回缸记录。
- **余浆回缸**：剩余浆称重并记录去向批次；回缸量须经另一人复核才释放进余量恢复领用，复核前不释放原批次余量。
- **失效重算**：改原重量或撤回领用会让关联成品和余浆记录标记「已失效」并按有效记录重算余量；旧记录保留，点批次卡片「履历」或调 `GET /api/items/:id/history` 可查。

## 代码结构

- `lib/withdrawal.js` — 领用判定：余量计算、按订单领用、超限拒绝、撤回/改原重量级联重算、回缸复核释放。
- `lib/archive.js` — 成品存档：帘数登记、破帘/异物转返浆、关联记录失效标记。
- `server.js` — HTTP 路由；`page()` 内嵌脚本为页面动作（领用/存档/回缸/复核/撤回/改重量/履历）。

## 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/items/:id/withdrawals` | 按订单领用（`orderNo`/`amount`/`by`） |
| POST | `/api/withdrawals/:id/cancel` | 撤回领用，关联记录失效重算 |
| POST | `/api/withdrawals/:id/products` | 成品存档（`sheets`/`broken`/`foreign`/`defectPulp`/`by`） |
| POST | `/api/items/:id/returns` | 余浆称重回缸（`amount`/`targetBatchId`/`by`） |
| POST | `/api/returns/:id/review` | 另一人复核（`reviewedBy` 须不同于交回人） |
| PATCH | `/api/items/:id/weight` | 改原重量，关联记录失效重算 |
| GET | `/api/items/:id/history` | 批次履历（含已撤回/已失效记录） |
| GET | `/api/withdrawals` `/api/products` `/api/returns` | 记录列表，支持 `?batch=` 过滤 |
