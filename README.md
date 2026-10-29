# 奇维 Kiwi 短剧推荐系统

奇维 Kiwi 是我围绕观剧偏好与作品资料管理开发的个人项目，采用前后端分离架构。通过自然语言描述想看的题材、剧情特色和排除项，核对偏好后获取有资料依据的推荐；同时提供完整的片库、账号收藏、反馈、历史片单、视频预览与资料纠错审核流程。

**项目简介：** 奇维 Kiwi：基于 FastAPI、Vue 3 与 RAG 的个人短剧推荐项目，支持自然语言偏好解析、语义检索、收藏反馈、历史片单、视频预览及资料纠错审核。

项目已完成当前业务范围内的功能实现，可在本地运行和演示，后续持续扩展功能。详细实现及验证范围见 [实现与验收](docs/实现与验收.md)。

## 功能

| 模块 | 已实现内容 |
| --- | --- |
| 片库管理 | 按类别分页采集、来源标识去重、增量更新、进度查看、剧名搜索、题材筛选和数字分页 |
| 偏好推荐 | 自然语言解析、偏好编辑确认、必须条件与排除项、三态事实筛选、语义检索和推荐依据校验 |
| 连续调整 | 基于当前条件追加、替换或取消偏好，展示差异，确认后生成；失败保留原条件与片单 |
| 个性化发现 | 收藏风格轮播与提示词、“不感兴趣／已看过”反馈、撤销反馈及按已确认条件换一批 |
| 账号与个人空间 | 注册登录、服务端 Session、账号隔离、昵称与头像、收藏概览、只读兴趣画像和密码修改 |
| 历史片单 | 自动保存登录后的成功片单、分页回看、删除、沿用偏好及历史资料变化提示 |
| 视频预览 | 剧集首集 15 秒片段自动准备、侧边预览、声音控制、任务恢复及失败状态；漫画保留阅读入口 |
| 纠错与审核 | 本人纠错记录、指定审核者工作台、来源与字段差异核对、采纳发布、人工字段保护、作品停用与恢复 |

推荐流程：**描述需求 → 核对偏好 → 条件筛选与语义检索 → 查看推荐 → 调整或换一批**。

资料维护流程：**发现问题 → 提交纠错 → 审核核对 → 发布资料与索引 → 查看处理结果**。

## 技术实现

| 层次 | 技术与职责 |
| --- | --- |
| 前端 | Vue 3、TypeScript、Vite；响应式布局、表单交互、请求取消与账号状态隔离 |
| 后端 | Python、FastAPI、Pydantic 2；HTTP 接口、严格校验、权限、任务和错误处理 |
| 推荐 | LangChain、DeepSeek、百炼 text-embedding-v4；结构化偏好、1024 维向量检索与引用校验 |
| 数据 | SQLAlchemy、Alembic；本地 SQLite，保留 PostgreSQL／pgvector 路径 |
| 媒体 | Node Playwright、FFmpeg／ffprobe；公开首集解析、片段处理及文件检查 |
| 测试 | pytest、Vitest、Node Test Runner、Playwright；接口、事务、状态竞争与浏览器流程 |

硬条件先由 SQL 执行，再进行语义排序；未知事实不会被当作符合排除条件。审核发布采用锁外索引准备、锁内权限与版本复核，在同一事务中提交资料、索引、审核事件和幂等回执。收藏、反馈与历史归属服务端 Session 对应账号。

## 快速开始

建议使用 Python 3.13 和 Node.js 24；前端要求 Node.js 22.12 及以上。以下为 Windows PowerShell 示例：

```powershell
git clone https://github.com/N-nut/kiwi-AIvideo-recommender.git
cd kiwi-AIvideo-recommender
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock
.\.venv\Scripts\python.exe -m pip install --no-deps -e backend
npm.cmd ci
npm.cmd --prefix frontend ci
npm.cmd run build:app
Copy-Item .env.example .env
```

在 `.env` 中配置 `DEEPSEEK_API_KEY` 与 `DASHSCOPE_API_KEY`，然后启动：

```powershell
npm.cmd start
```

访问 [本地网页](http://127.0.0.1:8000/)，或使用项目内的 `启动产品.cmd`。密钥由后端读取；数据库、会话、照片、媒体文件和 `.env` 不进入 Git 仓库。新环境首次更新片库后建立本地资料及向量，媒体按任务状态逐步准备。

无需模型调用时，可显式运行 `npm.cmd start -- --baseline` 使用标签基线与证据模板，页面会标记该模式。完整配置、前后端开发、迁移、审核授权、媒体工具、Compose 和备份方法见 [运行与维护](docs/运行与维护.md)。

## 测试与验证

```powershell
npm.cmd test
.\.venv\Scripts\python.exe -X utf8 -m pytest backend/tests
npm.cmd --prefix frontend test
npm.cmd --prefix frontend run build
node scripts/test-postgres.mjs
```

功能验证包含接口与事务、账号隔离、重复提交、版本冲突、失败回滚，以及桌面和手机宽度下的操作流程。各阶段的实际测试数量、浏览器报告、截图和复现命令收录于 [实现与验收](docs/实现与验收.md)。

当前运行方式以本地单服务为主；Docker／Nginx 配置已提供，原生 PostgreSQL 多连接、真实双设备与 HTTPS 部署仍需单独验收。PGlite／pgvector 验证兼容路径，独立人工剧情复核和推荐相关性评估另行记录，不将规则检查结果作为推荐准确率。

## 文档

- [项目介绍](项目介绍.md)：开发背景、当前功能和项目特点。
- [产品设计](产品设计文档.md)：功能、交互、数据原则及验收要求。
- [技术方案](docs/技术方案.md)：架构、数据模型、接口、事务及状态处理。
- [运行与维护](docs/运行与维护.md)：配置、升级、部署、备份与功能验证。
- [实现与验收](docs/实现与验收.md)：当前完成情况与按日期保留的验证记录。
- [资料与审核](data/审核说明.md)、[媒体预览](docs/媒体预览.md)：来源、处理规则及媒体任务。

`Demo.html` 和 `demo/` 是另存的早期离线演示，使用模拟数据；完整项目由 `frontend/` 与 `backend/` 组成，默认 `npm.cmd start` 启动完整项目。离线演示的历史验收见 [Demo 记录](demo/验收记录.md)。

## 后续迭代

在现有完整功能上，继续完善独立相关性评估、扩大受控偏好表达覆盖，并根据实际评估结果考虑混合检索、重排序和部署优化。

所有短剧来源红果短剧，推荐大家前往红果短剧观看。项目保留具体作品来源入口；自动整理资料标明核对范围，媒体当前用于本地开发验证。
