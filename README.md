# 奇维 Kiwi · AI 漫剧智能推荐系统

已实现可本地运行的 RAG MVP：**输入需求 → AI 解析 → 编辑确认 → 硬条件筛选与语义检索 → 带资料依据的推荐**。前端采用 Vue 3 / TypeScript，后端采用 FastAPI / SQLAlchemy / LangChain 模型适配，真实调用 DeepSeek 与百炼 text-embedding-v4（1024 维）。最多返回 3 部，不足时按实际数量返回。

首页右上角提供 **更新漫剧库**：后台读取指定红果分类页与热播榜当前页，采集真实标题、封面、简介、标签、集数及榜单信息，去重并原子更新。原 36 部 Bilibili 资料已停用。自动采集资料按用户授权用于开发验证，待人工复核。详见 [数据审核说明](data/审核说明.md)。

## 在这台电脑上启动

项目的独立 Python 环境、前端依赖和编译结果均已准备，可在项目目录执行：

```powershell
npm.cmd start
```

打开 [本地产品](http://127.0.0.1:8000/)，保持终端运行。也可直接双击项目内 `启动产品.cmd`。端口冲突时执行 `npm.cmd start -- --port 8001`。启动保留上次同步结果，不再自动导入旧 36 部资料。

Windows PowerShell 可能因执行策略拦截 `npm.ps1`，因此这里明确使用 `npm.cmd`，无需修改系统执行策略。

本机通过 SQLite 保存真实资料和真实向量，在 Python 中执行精确余弦排序；必须条件和三态排除仍由 SQL 执行。正式部署路径采用 PostgreSQL + pgvector，在数据库内执行约束和精确向量排序。不会在服务出错后切到虚构作品。

## 从新环境安装

已实测 Python **3.13.9**、Node **24.14.0**。Python 依赖固定于 `backend/requirements.lock`，前端与 PostgreSQL 测试辅助包各有 `package-lock.json`。

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r backend/requirements.lock
.\.venv\Scripts\python.exe -m pip install --no-deps -e backend
npm.cmd ci
npm.cmd --prefix frontend ci
npm.cmd run build:app
Copy-Item .env.example .env
```

在 `.env` 填写 `DEEPSEEK_API_KEY`、`DASHSCOPE_API_KEY` 后运行 `npm.cmd start`。也支持系统环境变量。密钥只由后端读取。百炼密钥的地域须与 `EMBEDDING_BASE_URL` 一致。默认 DeepSeek 模型为 `deepseek-chat`，可配置 `DEEPSEEK_MODEL`。

无密钥也能启动、采集和浏览作品；缺少百炼密钥时不创建向量，健康检查会保留未就绪状态。配置密钥后再次更新即可补齐索引。也可**显式**执行 `npm.cmd start -- --baseline` 使用标签基线和证据模板，页面会标记基线模式，不调用模型。

前端开发分别运行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn kiwi.main:app --host 127.0.0.1 --port 8000
npm.cmd --prefix frontend run dev
```

打开 Vite 输出的地址（默认 5173），`/api`、`/health` 代理到后端。

## 使用与数据导入

点击首页“更新漫剧库”即可开始更新，页面显示采集/索引进度和最近成功时间，完成后自动刷新卡片。刷新网页后可继续查看运行中的任务。30 秒内重复点击复用最近结果，运行中不会重复发起任务。

固定来源仅为 [真人剧分类首页](https://hongguoduanju.com/category/real-drama) 和 [红果热播榜首页](https://hongguoduanju.com/rank/hot-drama)。当前同步这两个页面展示的片单，不遍历后续分页或下载视频。真人剧按来源标注，榜单未明确标注类型的作品显示“未标注”。

两个页面均成功读取、字段校验和向量化完成后才覆盖本次红果片单；其他手工导入资料保留。页面/模型失败时保留原库。热度、封面或日期变化复用原有向量，简介变化才重新索引。更新状态存入数据库；本版按本地单进程服务设计，多实例调度与后台审核留待后续实现。

`POST /api/v1/catalog/refresh` 启动任务，`GET /api/v1/catalog/refresh` 查看状态。来源由后端固定，不接受外部爬取 URL。已有 SQLite 安装会原位增加来源字段并移除指定旧种子；PostgreSQL 由 Alembic 0002 迁移。

- 点击“理解我的口味”后检查识别结果；可调整题材、主题、节奏、排除项和必须条件，再点击确认生成。修改描述会重置本轮偏好，旧请求的迟到结果不能覆盖新输入。
- 不要后宫时，只有 `harem=false` 能通过，`true` 和未知均排除；来源未说明的特征不会推断为“没有”。
- 作品详情展示原始简介、证据、资料日期和官方链接。名称、链接和简介来自数据库；生成的 ID、证据和引用经过校验。生成失败时使用证据模板并标识。
- 悬停卡片约 260ms 弹出视频预览，静音循环播放原创模拟氛围动画，按题材复用，非真实作品片段。移出、关闭或切换页面会停止并卸载视频；浏览器禁止自动播放或设置减少动态效果时，可手动播放。手机和键盘也可使用卡片上的“预览”按钮。
- 详情弹窗只滚动正文，隐藏可见滚动条，标题、关闭按钮及底部操作保持可见；点击旁边空白处或按 Esc 可关闭。
- 完结、时长等未支持的明确条件需要用户主动调整或移除；冲突条件不直接推荐。
- 昵称登录与收藏只保存在当前浏览器，不提供真实认证和跨设备同步。

空的 [默认种子文件](data/works.json) 不再预装作品。JSON 结构见 [WorkInput](backend/kiwi/schemas.py)，可用 `scripts/collect-sources.py` 将相同来源导出到 `data/source-cache/hongguo.json`。非空摘要、标签或三态事实均需要原文证据；只有审核通过记录参与检索。

```powershell
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json
# 已有 ID 内容变化，显式允许更新
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json --update
# 重建时必须提供整库；本版固定 1024 维
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json --update --reembed
```

重复且一致的 ID 跳过，同批冲突或疑似同名作品报错。整批校验或向量化失败时不提交部分更新。将 `approved` 改回 `pending` 也需显式 `--update`。

## 测试与评测

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run build
.\.venv\Scripts\python.exe -m pytest backend -q
npm.cmd --prefix frontend test
npm.cmd run build:app
node scripts/test-postgres.mjs
.\.venv\Scripts\python.exe scripts/evaluate.py
```

`test-postgres.mjs` 在一次性内存 **PostgreSQL 18.6 / PGlite** 中通过真正的 psycopg 网络连接验证 Alembic、JSONB 条件、pgvector 距离及事务，不安装系统数据库。它不是多连接并发或 Docker 部署验收。直接运行 pytest 时，未配置 PostgreSQL 的一项测试会明确跳过。

也可通过 `KIWI_TEST_DATABASE_URL` 指向空的独立 PostgreSQL + pgvector 测试库，数据库名必须包含 `test`。测试会创建并删除测试表，请勿指定业务数据库。

真实付费模型评测单独执行：

```powershell
.\.venv\Scripts\python.exe scripts/evaluate.py --live --concurrency 2
# 额外调用解析模型；不加 --parse 时使用固定确认结构
.\.venv\Scripts\python.exe scripts/evaluate.py --live --parse --concurrency 2
```

旧 36 部作品对应的 24 条参考需求已停用；现存评测报告仅记录 2026-10-21 历史结果，不适用于红果库。`scripts/evaluate.py` 会拒绝空的参考集，需先针对新库重新标注，不能将历史指标当作新库效果。

## Docker Compose 与备份

准备好 `.env` 后：

```powershell
docker compose up --build -d
```

打开 [Compose 本地入口](http://127.0.0.1:8080/)。三个服务分别为 pgvector PostgreSQL、FastAPI、Nginx；启动时执行迁移和幂等导入，数据库保存在 `kiwi-db` 持久卷。可在 `.env` 配置 `POSTGRES_PASSWORD`；数据库 URL 中的特殊字符需要 URL 编码。

```powershell
# 先导出到容器，再复制，避免 Windows 重定向破坏二进制文件
docker compose exec db pg_dump -U kiwi -d kiwi -Fc -f /tmp/kiwi.dump
docker compose cp db:/tmp/kiwi.dump ./kiwi.dump
# 恢复会覆盖当前库，请先保存需要的数据
docker compose cp ./kiwi.dump db:/tmp/restore.dump
docker compose exec db pg_restore -U kiwi -d kiwi --clean --if-exists /tmp/restore.dump
```

本机没有 Docker，完整镜像构建、三容器启动和备份恢复尚未实测。已有迁移测试和 WASM PostgreSQL SQL 验证不能替代部署验收。

## 文档与原型

- [产品设计](产品设计文档.md)、[技术方案](docs/技术方案.md)
- [实现与验收记录](docs/实现与验收.md)、[数据审核说明](data/审核说明.md)
- 历史评测（旧作品库）：[标签基线](docs/evaluation-baseline.json)、[真实向量](docs/evaluation-live.json)
- [后端 OpenAPI](http://127.0.0.1:8000/docs)；`/health/live` 检查存活，`/health/ready` 检查配置、资料和向量版本。
- 原有 `Demo.html` 保留：双击离线体验 12 部虚构作品和原创模拟视频。单独服务命令改为 `npm.cmd run demo`。修改 `demo/` 后运行 `npm.cmd run build` 重新打包。

正式页面不混入原型的虚构作品。账号认证、服务端收藏、真实视频、跨设备同步、多轮对话、协同过滤及重排序属于后续范围。
