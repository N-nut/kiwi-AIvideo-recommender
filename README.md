# 奇维 Kiwi · AI 漫剧智能推荐系统

已实现可本地运行的 RAG MVP：**输入需求 → AI 解析 → 编辑确认 → 硬条件筛选与语义检索 → 带资料依据的推荐**。前端采用 Vue 3 / TypeScript，后端采用 FastAPI / SQLAlchemy / LangChain 模型适配，真实调用 DeepSeek 与百炼 text-embedding-v4（1024 维）。最多返回 3 部，不足时按实际数量返回。

首批 36 部真实动态漫的官方简介已整理并完成真实向量入库。按用户授权，当前为 **AI 来源核对的开发数据，待独立人工复核**；作品是否由 AI 制作未知。详见 [数据审核说明](data/审核说明.md)。

## 在这台电脑上启动

项目的独立 Python 环境、前端依赖和编译结果均已准备，可在项目目录执行：

```powershell
npm.cmd start
```

打开 [本地产品](http://127.0.0.1:8000/)，保持终端运行。也可直接双击项目内 `启动产品.cmd`。端口冲突时执行 `npm.cmd start -- --port 8001`。重复启动会跳过已入库内容。

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

无密钥时可**显式**执行 `npm.cmd start -- --baseline`，使用同一真实作品库的标签基线和证据模板；页面会标记基线模式，不调用模型。它不是服务失败时的自动降级。

前端开发分别运行：

```powershell
.\.venv\Scripts\python.exe -m uvicorn kiwi.main:app --host 127.0.0.1 --port 8000
npm.cmd --prefix frontend run dev
```

打开 Vite 输出的地址（默认 5173），`/api`、`/health` 代理到后端。

## 使用与数据导入

- 点击“理解我的口味”后检查识别结果；可调整题材、主题、节奏、排除项和必须条件，再点击确认生成。修改描述会重置本轮偏好，旧请求的迟到结果不能覆盖新输入。
- 不要后宫时，只有 `harem=false` 能通过，`true` 和未知均排除。因此首批资料在“不要后宫”时没有推荐，不能为凑数放宽。
- 作品详情展示原始简介、证据、资料日期和官方链接。名称、链接和简介来自数据库；生成的 ID、证据和引用经过校验。生成失败时使用证据模板并标识。
- 完结、时长等未支持的明确条件需要用户主动调整或移除；冲突条件不直接推荐。
- 昵称登录与收藏只保存在当前浏览器，不提供真实认证和跨设备同步。

JSON 结构见 [作品数据](data/works.json)。非空摘要、标签或三态事实均需要原文证据；只有审核通过记录参与检索。

```powershell
.\.venv\Scripts\python.exe -m kiwi import --file data/works.json
# 已有 ID 内容变化，显式允许更新
.\.venv\Scripts\python.exe -m kiwi import --file data/works.json --update
# 重建时必须提供整库；本版固定 1024 维
.\.venv\Scripts\python.exe -m kiwi import --file data/works.json --update --reembed
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

固定 24 条需求覆盖题材、未知排除、冲突、未支持条件和无结果。报告记录数据哈希、Prompt 版本、模型、阈值、候选、引用、耗时及 Token 用量。参考标签由 AI 整理，人工相关性、理由支持度与剧透检查待独立审核；不得把参考指标当作人工准确率。

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
- [标签基线评测](docs/evaluation-baseline.json)、[真实向量评测](docs/evaluation-live.json)
- [后端 OpenAPI](http://127.0.0.1:8000/docs)；`/health/live` 检查存活，`/health/ready` 检查配置、资料和向量版本。
- 原有 `Demo.html` 保留：双击离线体验 12 部虚构作品和原创模拟视频。单独服务命令改为 `npm.cmd run demo`。修改 `demo/` 后运行 `npm.cmd run build` 重新打包。

正式页面不混入原型的虚构作品。账号认证、服务端收藏、真实视频、跨设备同步、多轮对话、协同过滤及重排序属于后续范围。
