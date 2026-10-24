# 奇维 Kiwi · AI 漫剧智能推荐系统

已实现可本地运行的 RAG MVP：**输入需求 → AI 解析 → 编辑确认 → 硬条件筛选与语义检索 → 带资料依据的推荐**。前端采用 Vue 3 / TypeScript，后端采用 FastAPI / SQLAlchemy / LangChain 模型适配，真实调用 DeepSeek 与百炼 text-embedding-v4（1024 维）。最多返回 3 部，不足时按实际数量返回。

桌面左侧栏底部提供 **更新漫剧库**、更新状态和账号区，手机适配为导航下方工具区：选择真人剧、漫剧、AI剧、漫画及可选热播榜，后台自动翻页，采集真实标题、封面、简介、标签、集数或章节与榜单信息，按来源标识增量入库。原 36 部 Bilibili 资料已停用。自动采集资料按用户授权用于开发验证，待人工复核。详见 [数据审核说明](data/审核说明.md)。

## 在这台电脑上启动

项目的独立 Python 环境、前端依赖和编译结果均已准备，可在项目目录执行：

```powershell
npm.cmd start
```

打开 [本地产品](http://127.0.0.1:8000/)，保持终端运行。也可直接双击项目内 `启动产品.cmd`。端口冲突时可执行 `npm.cmd start -- --port 8001`，并将 `http://127.0.0.1:8001` 加入 `.env` 的 `AUTH_ALLOWED_ORIGINS` 后重启。启动保留上次同步结果，不再自动导入旧 36 部资料。

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

点击首页“更新漫剧库”，默认勾选漫剧、AI剧，可增加真人剧、漫画和热播榜。页面显示实际类别、当前页、已读取页数、原始条数、去重数量和索引进度，完成后自动刷新卡片。刷新网页后继续查看同一任务；运行中不重复发起，结束后 30 秒内复用最近结果。

后端固定来源为 [真人剧](https://hongguoduanju.com/category/real-drama)、[漫剧](https://hongguoduanju.com/category/comic-drama)、[AI剧](https://hongguoduanju.com/category/ai-drama)、[漫画](https://hongguoduanju.com/category/comic) 和 [热播榜](https://hongguoduanju.com/rank/hot-drama)。默认每来源最多 **5 页**，整个任务最多 **25 页、500 部**；达到上限明确显示限定范围。每次从第一页开始，按来源分页信息停止，不承诺全站全量。漫画独立保存标识、章节与阅读链接；分类信息优先于榜单缺失标签。

本次限定范围的页面、字段校验和向量化全部成功后，一次事务新增或更新；**不会删除本次未出现的作品**。同名不同来源 ID 保留，人工拒绝状态不会被自动批准。页面、模型或超时失败保留原库。仅热度、封面或日期变化复用向量，检索文本变化才重新索引。状态存入数据库；本版按本地单进程服务设计，多实例调度与后台审核留待后续实现。

`POST /api/v1/catalog/refresh` 提交范围，`GET /api/v1/catalog/refresh` 查看状态。请求示例：

```json
{"categories":["comic-drama","ai-drama"],"include_hot_rank":false}
```

来源由后端固定，不接受外部爬取 URL。`.env.example` 提供页数、作品数和时间预算配置；请求串行间隔至少 0.5 秒，采集/索引/全任务默认分别最多 300/600/900 秒。已有 SQLite 原位升级；PostgreSQL 沿用 Alembic 0002，本轮只扩展 JSON 字段，无需新增实体列。

- 点击“理解我的口味”后检查识别结果；可调整题材、主题、节奏、排除项和必须条件，再点击确认生成。修改描述会重置本轮偏好，旧请求的迟到结果不能覆盖新输入。
- 不要后宫时，只有 `harem=false` 能通过，`true` 和未知均排除；来源未说明的特征不会推断为“没有”。
- 作品详情展示原始简介、证据、资料日期和官方链接。名称、链接和简介来自数据库；生成的 ID、证据和引用经过校验。生成失败时使用证据模板并标识。
- 首页有六部作品的封面轮播，竖版海报完整展示，可前后切换或暂停；当前按片库顺序展示，收藏个性化留待后续。已移除默认三张卡片和问号弹窗；尚未生成片单时，虚线框直接展示三步指引，用户确认后才展示推荐作品。
- “未标注”类别已移除：本批来源合并后仍缺少明确内容类型的记录在清洗阶段剔除，更新详情会显示数量；剧情事实未知仍保持三态。
- 详情移除装饰口号和内部证据编号，重复依据合并并默认折叠；更新成功统计也默认收起，按需展开。
- “片库”支持类别、题材筛选和剧名模糊搜索；标题旁输入关键词，停顿 300ms 或按回车即查询整个已审核片库，查询变化重置页码。服务端每页加载 12 部，页码可直接点击，首尾和当前页附近数字动态切换。账号收藏复用数字分页，不随片库翻页丢失；不可用资料可展开管理并取消收藏。
- 卡片采用 2:3 竖版海报，桌面约 200～280px，窄屏减少列数；图片失败使用同尺寸占位图。漫画展示阅读资料预览。
- 悬停卡片约 260ms 弹出视频预览，静音循环播放原创模拟氛围动画，按题材复用，非真实作品片段。移出、关闭或切换页面会停止并卸载视频；浏览器禁止自动播放或设置减少动态效果时，可手动播放。手机和键盘也可使用卡片上的“预览”按钮。
- 详情弹窗只滚动正文，隐藏可见滚动条，标题、关闭按钮及底部操作保持可见；点击旁边空白处或按 Esc 可关闭。
- 完结、时长等未支持的明确条件需要用户主动调整或移除；冲突条件不直接推荐。
- 左侧栏下方“登录 / 注册”支持用户名密码注册、登录和退出；头像与个人空间目前只展示位置样例。注册即登录，刷新和服务重启可恢复 7 天内的有效会话。密码以 Argon2id 保存，Cookie 为 HttpOnly。游客仍可浏览和生成片单；游客收藏会先登录，再继续该次操作。
- 收藏保存在账号中，不同账号隔离。同账号访问同一后端和数据库即可恢复；已用两套独立 Cookie 存储验证，真实双设备随部署验收。旧 `kiwi-real-library-v1` 按演示昵称提示，用户确认选中组后才导入，每批最多 100 条；跳过失效资料、可重试且保留原始本地字典。
- 新增账号和收藏写请求要求 `X-Kiwi-Request: 1` 和允许的完整来源；会话与个人接口禁止缓存。`.env.example` 提供 Cookie、允许来源、会话期限和单进程限流参数。HTTPS 部署必须设置 `AUTH_COOKIE_SECURE=true`，允许来源仅列部署域名。本地启动关闭代理头解析；Nginx 后的额度暂按代理 IP 共享。

空的 [默认种子文件](data/works.json) 不再预装作品。JSON 结构见 [WorkInput](backend/kiwi/schemas.py)，可用 `scripts/collect-sources.py` 将相同来源导出到 `data/source-cache/hongguo.json`。非空摘要、标签或三态事实均需要原文证据；只有审核通过记录参与检索。

```powershell
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json
# 已有 ID 内容变化，显式允许更新
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json --update
# 重建时必须提供整库；本版固定 1024 维
.\.venv\Scripts\python.exe -m kiwi import --file data/source-cache/hongguo.json --update --reembed
```

手工导入中重复且一致的 ID 跳过，同批冲突或疑似同名作品报错；网页来源同步按来源 ID 保留同名条目，不自动合并。整批校验或向量化失败时不提交部分更新。将 `approved` 改回 `pending` 也需显式 `--update`。

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

旧 36 部对应的 24 条需求和报告保留为历史记录。当前 [25 条固定需求](data/evaluation.json) 基于 192 部红果资料的源站标签建立规则参考，**待独立人工相关性标注**。标签基线和真实向量模式读取相同本机库，报告保存为 `docs/evaluation-hongguo-*.json`；不覆盖历史报告，也不把规则命中率称为推荐准确率。脚本校验检索内容指纹；后续片库变化后须复核并更新参考集，旧指标不能直接沿用。

## 账号升级与本地验收

从尚无账号表的 SQLite 升级前，先执行备份辅助脚本（仅支持现有 SQLite 文件）：

```powershell
.\.venv\Scripts\python.exe scripts/prepare-accounts.py
```

脚本使用 SQLite backup API 生成时间戳备份、检查完整性，再创建账号表，并校验作品、向量和更新状态的整体指纹不变。本机本轮备份与结果见 [账号验收记录](docs/实现与验收.md)。新环境启动自动建表；PostgreSQL 使用新增 Alembic `0003_accounts`。回滚前先停止服务并恢复匹配的数据库备份。

自动账号检查包含在上面的 pytest、Vue 和 PostgreSQL 命令中。浏览器脚本 `scripts/verify-accounts.mjs` 使用 Playwright 和已安装的 Edge，仅连接回环 HTTP；验收时请将公共作品库复制到独立 SQLite 文件，配置 `AI_MODE=baseline`、该测试库的 `DATABASE_URL` 和 `AUTH_ALLOWED_ORIGINS=http://127.0.0.1:8001`，启动 8001 后执行脚本。它会在测试库创建合成账号，不调用付费模型。可用 `KIWI_PLAYWRIGHT_MODULE` 指定已安装的 Playwright 模块；报告见 [浏览器验证](docs/account-browser-validation.json)。本轮使用桌面 1440×1000、手机 390×844 两套独立 Cookie 存储。

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
- 当前库自动检查：[标签基线](docs/evaluation-hongguo-baseline.json)、[真实向量](docs/evaluation-hongguo-live.json)；参考标注仍待人工复核。
- [后端 OpenAPI](http://127.0.0.1:8000/docs)；`/health/live` 检查存活，`/health/ready` 检查配置、资料和向量版本。
- 原有 `Demo.html` 保留：双击离线体验 12 部虚构作品和原创模拟视频。单独服务命令改为 `npm.cmd run demo`。修改 `demo/` 后运行 `npm.cmd run build` 重新打包。

正式页面提供真实账号与服务端收藏，旧 Demo.html 仍是离线演示。真实双设备及 HTTPS 部署、真实视频、收藏驱动轮播、多轮对话、协同过滤及重排序属于后续范围。
