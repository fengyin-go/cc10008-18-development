# 交互式数据分析工作台

离线版交互式数据分析工具，涵盖多源接入、查询分析、可视化图表、报告生成、异常检测与数据服务编排，所有分析配置与结果持久化到浏览器本地存储。

这是一个**纯前端**管理平台：React + Vite + TypeScript，仓库里没有后端服务。业务数据由
`frontend/src/data/` 下的本地数据层提供：首次打开用示例数据播种，之后的登记、筛选与状态流转
结果都持久化在浏览器 `localStorage` 里，刷新或重开浏览器都还在。dev server 已关掉自动打开页面，
启动后按终端打印的地址手工打开。

## 目录结构

```text
.
├── frontend/                 React + Vite + TypeScript 前端（唯一运行单元）
│   ├── src/views/            每个业务模块一个页面
│   ├── src/api/local-service.ts   本地数据服务：列表、筛选、动作流转、导出
│   ├── src/data/             模块元数据 / 示例数据 / localStorage 持久化
│   ├── src/stores/           会话与筛选状态
│   └── vite.config.ts        dev server 配置（open: false，无 /api 代理）
├── .gitignore
└── docker-compose.yml
```

## 启动

```bash
cd frontend
npm install
npm run dev
```

前端默认监听 `http://127.0.0.1:5173/`，dev server 不会自动打开浏览器，需要自己访问。

生产构建：

```bash
cd frontend
npm run build
```

## 业务模块

| 模块 | 目录 | 业务对象 | 主要字段 |
| --- | --- | --- | --- |
| 交互查询 | `query` | 查询语句 | 语句编号、查询表达式、目标数据集 |
| 可视化图表 | `chart` | 图表配置 | 图表编号、图表名称、图表类型 |
| 数据源接入 | `source` | 接入配置 | 配置编号、连接类型、接入地址 |
| 聚合计算 | `aggregate` | 聚合方案 | 方案编号、聚合函数、目标字段 |
| 数据筛选 | `filter` | 筛选规则 | 规则编号、目标数据集、筛选字段 |
| 报告生成 | `reportgen` | 报告模板 | 模板编号、模板名称、包含图表 |
| 异常检测 | `anomaly` | 检测规则 | 规则编号、监控指标、基线均值 |
| 多维下钻 | `drill` | 下钻路径 | 路径编号、起点维度、下钻层数 |
| 对比分析 | `compare` | 对比方案 | 方案编号、基准数据集、对照数据集 |
| 分析流水线 | `pipeline` | 流水线节点 | 节点编号、节点类型、输入源 |
| 数据集管理 | `datastore` | 数据集定义 | 数据集编号、数据集名称、来源表名 |
| 趋势预测 | `forecast` | 预测模型 | 模型编号、模型类型、训练数据集 |
| 数据分片 | `segment` | 分片规则 | 规则编号、目标数据集、分片字段 |
| 调度管理 | `scheduler` | 调度配置 | 配置编号、关联任务、调度表达式 |
| 通知分发 | `notify` | 通知规则 | 规则编号、触发条件、通知渠道 |
| 查询缓存 | `cache` | 缓存策略 | 策略编号、目标查询、缓存键规则 |
| 数据标签 | `tag` | 标签定义 | 标签编号、标签名称、计算表达式 |
| 数据分享 | `share` | 分享链接 | 链接编号、目标数据集、访问密码、有效期天数、最大浏览次数 |

## 数据分享的快照与访问规则

分享链接生成时会冻结一份不可变快照（水印、目标数据集、报告模板与图表清单、生成时间、校验和），
之后报告模板改名、数据集调整、分享配置变更都不会回写旧链接。实现集中在
`frontend/src/api/share-service.ts`，页面只调用它：

- **打开链接**：`/share/open/:token?channel=邮件`，快照内容只有访问成功后才展示。
- **重复生成**：同一分享配置已有有效链接时直接复用（同一快照、同一计数、同一有效期）。
- **失败原因分开返回**：`BAD_PASSWORD`（密码错误）、`REVOKED`（已撤销）、`EXPIRED`（过期）、
  `VIEW_LIMIT_REACHED`（次数耗尽）、`DOWNLOAD_DISABLED`（下载关闭）、`SNAPSHOT_INVALID`（快照缺失或校验失败）。
- **访问批次**：每次访问（含失败）都记录时间、来源渠道、动作、结果与是否计次；
  只有成功访问 `counted=true` 才消耗浏览次数，首次访问时间单独记录。
- **并发**：计数与生成都是同步读改写事务，最后一个可用次数只会有一个请求拿到，其余留下失败批次。
- **水印为空**：可以登记配置，但生成链接会被拒绝。
- **有效期 / 次数 / 下载开关的变更**只影响之后的行为：旧链接的 `expiresAt`、`maxViews` 在生成时固定；
  下载开关按分享配置的当前值判断，关闭后页面预览仍可打开，文件请求返回 `DOWNLOAD_DISABLED`。
- **清理与诊断**：管理页的「清理残留与重复记录」会去重令牌/有效链接、合并访问批次、移除孤儿链接、
  停用坏快照并按需执行过期自动清理；「自检与诊断」只读，不消耗次数。

重置数据分享模块会同时清掉链接、访问批次与历史归档（`resetModule('share')`）。

## 约定

- 每个模块的页面在 `frontend/src/views/<模块>/index.vue`，页面只负责渲染，读写统一走
  `frontend/src/api/local-service.ts`（数据分享额外经由 `share-service.ts`）。
- 字段、状态、动作与流转目标集中在 `frontend/src/data/modules.ts`；示例数据在
  `frontend/src/data/seed.ts`。
- 状态流转只允许在 `local-service.ts` / `share-service.ts` 里改，页面组件不做业务判断。
- 想回到初始数据：清掉浏览器里 `interactive-analytics-lab:entries` 这一项，或调用 `resetModule(模块)`。
  分享链接单独存储在 `interactive-analytics-lab:share-links`，重置数据分享模块时会一并清空。

领域：数据工程
子方向：数据分析与数据应用
