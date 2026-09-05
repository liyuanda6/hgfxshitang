# 部署到 Cloudflare Pages + D1

本系统已改造为「前端纯静态 + 后端 Cloudflare Pages Function + D1 数据库」，可**免费**部署到 Cloudflare，无需买云服务器。

> ⚠️ **不要用 Cloudflare 控制台的「拖文件夹上传 / Drag and drop」方式部署本项目。**
> 官方明确：控制台 Direct Upload **不支持编译 `functions/` 目录**（Pages Functions）。本项目后端（登录、D1 读写、xlsx 导出）全部在 `functions/` 里，拖拽上传后 `/api/*` 全部 404、功能不可用。
> 必须用 **Wrangler 命令行**（`wrangler pages deploy public`）或 **Git 集成** 部署，二者才会编译 `functions/` 并应用 `wrangler.toml` 里的 `nodejs_compat` 与 D1 绑定。

> 改造要点：原来 `server.js` 把数据写在本地 `data.json`。Cloudflare 磁盘是临时的，因此：
> - 持久层改为 **D1（SQLite）**，由 `core/handler.mjs` 读写；
> - 入口从 Node `http` 改为 Pages Function 的 `onRequest`（文件 `functions/api/[[path]].js`）；
> - 费用计算抽到共享纯函数 `core/fees.mjs`，云端与本地 `server.js` 算出的数字**完全一致**（已自测：一年级1班合计 766、一年级2班 504）；
> - 前端 `public/` 无需任何改动（它请求的是相对路径 `/api/*`，同源）。
>
> `server.js` 原文件保留，仍可用于本地 `node server.js` 文件版运行（开发/内网）。

---

## 零基础保姆级步骤（照抄即可）

> 一句话：本项目有后端（functions/ + core/），**必须用 Wrangler 命令行部署**，网页拖拽上传不支持后端。下面按顺序复制粘贴即可。

0. 文件资源管理器进 `class-meal-system` 文件夹，地址栏输入 `cmd` 回车，打开命令行。
1. `node -v` 确认 ≥ v18（没有就去 nodejs.org 装 LTS）。
2. `npm install -g wrangler`
3. `npx wrangler login`（浏览器点允许）
4. `npx wrangler d1 create class-meal-db` → 复制输出的 `database_id`
5. 记事本打开 `wrangler.toml`，把 `database_id = "REPLACE_WITH_YOUR_D1_ID"` 换成第 4 步的 ID，保存
6. `npx wrangler d1 migrations apply class-meal-db --remote`（问 y/N 输入 y）
7. `npx wrangler pages deploy public` → 项目名输入 `class-meal-system`（同名会覆盖之前拖拽建的坏项目）
8. 打开结尾给出的 `*.pages.dev` 网址，首次自动建 27 班，改掉默认密码 `admin`

---

## 一、准备

1. 安装 Node.js ≥ 18（本地用，运行 `wrangler`）。
2. 注册 Cloudflare 账号（免费）。
3. 在本机安装 Wrangler：
   ```bash
   npm install -g wrangler
   wrangler --version
   ```
4. 登录 Cloudflare：
   ```bash
   npx wrangler login
   ```
   浏览器弹窗授权即可。

---

## 二、创建 D1 数据库

```bash
npx wrangler d1 create class-meal-db
```

执行后会输出一个 `database_id`。把它填进 `wrangler.toml` 的：
```toml
database_id = "REPLACE_WITH_YOUR_D1_ID"   # ← 改成上面输出的 id
```

---

## 三、执行数据库表结构（migrations）

```bash
# 远程库
npx wrangler d1 migrations apply class-meal-db --remote

# 本地调试库（可选，本地 dev 用）
npx wrangler d1 migrations apply class-meal-db --local
```

这会创建 `classes / students / days / records / meta` 五张表。

> 首次访问网站时，`loadState()` 会自动播种**全校 27 个班**（来自 `core/classes.mjs`）+ 默认管理员密码 `admin`，无需手动建班。

---

## 四、部署

### 方式 A：CLI 直接上传（最简单）
在项目根目录执行：
```bash
npx wrangler pages deploy public
```
按提示为项目命名（如 `class-meal-system`）。部署完成后得到地址 `https://<项目名>.pages.dev`。

### 方式 B：Git 集成（推荐，后续改代码自动部署）
1. 把整个 `class-meal-system/` 目录推到 GitHub 仓库。
2. Cloudflare 控制台 → **Workers & Pages** → **Create** → **Pages** → 导入 Git 仓库。
3. 构建设置：
   - Framework preset：**None**
   - Build command：留空
   - Build output directory：`public`
4. 在 **Settings → Functions** 里确认 D1 绑定（binding 名 `DB`，数据库 `class-meal-db`）已关联；或部署后到 **Settings → Variables / D1** 绑定。
5. 保存后每次 `git push` 自动重新部署。

---

## 五、本地调试（可选）

```bash
npx wrangler pages dev public --d1=DB
```
打开 `http://localhost:8788`，API 走 `/api/*`，数据落在本地 D1（`.wrangler/` 下），不会污染线上库。

---

## 六、上线后必做

1. 浏览器打开你的 Pages 地址，首次访问会自动建好 27 个班。
2. **立即到「系统设置」页把管理密码 `admin` 改掉**（安全！）。
3. 在「学生管理」页导入各班学生 + 9 月就餐记录。
4. 「统计报表」页点「导出全校餐费核对表」，即得 27 个工作表的 xlsx（每班一表，含合并标题 / SUM 合计 / 班主任·后勤审核签名行）。

---

## 七、数据备份与迁移

所有数据都在 D1，可随时导出：
```bash
npx wrangler d1 execute class-meal-db --remote --command="SELECT * FROM classes"   # 查看
npx wrangler d1 export class-meal-db --remote --output=backup.sql                  # 整库导出为 SQL
```
需要把**本机 `data.json` 里已有的 27 班/学生**迁到 D1：部署上线后，直接在网页上重新「导入学生」即可（27 班已自动建好）；学生名单从本机导出 CSV 再在网页粘贴导入最省事。

---

## 八、常见坑

- **`compatibility_flags = ["nodejs_compat"]` 必须留着**：`lib/xlsx-export.js` 用 `Buffer` 在内存里拼 zip，`nodejs_compat` 提供 Buffer 全局。
- **`functions/api/[[path]].js` 是 catch-all**：所有 `/api/*` 都进这里，不要删 `[[ ]]`。
- **前端不改**：它请求 `/api/...` 同源，Pages 自动转发给 Function。
- **密码算法**：云端用 Web Crypto（`crypto.subtle.digest`，SHA-256 + 盐），与本地 `server.js` 的 `node:crypto` 结果一致，可互转。
- **首次部署若页面空白**：确认 `wrangler.toml` 的 `pages_build_output_dir = "./public"` 正确，且 `public/index.html` 存在。

---

## 九、文件结构（部署包）

```
class-meal-system/
├── public/                  # 前端静态站（不动，Wrangler 上传此目录）
├── functions/
│   └── api/[[path]].js      # Pages Function 入口，转发给 core/handler.mjs
├── core/
│   ├── handler.mjs          # 全部 API 逻辑 + D1 读写
│   ├── fees.mjs             # 费用计算（与 server.js 同算法）
│   ├── password.mjs         # Web Crypto 密码哈希
│   └── classes.mjs          # 全校 27 班清单（自动建班用）
├── lib/xlsx-export.js       # 零依赖 xlsx 生成器（Buffer/zip）
├── migrations/0001_init.sql # D1 表结构
├── school-classes.json      # 班级清单源（本地 server.js 也用）
├── wrangler.toml            # 部署配置
├── server.js                # 本地文件版（开发/内网用，云端不用）
└── DEPLOY-CLOUDFLARE.md      # 本文件
```

部署只需 `public/ + functions/ + core/ + lib/ + migrations/ + wrangler.toml` 这几样，`data/` 与 `server.js` 仅本地文件版使用。
