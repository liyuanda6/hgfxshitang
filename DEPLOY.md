# 部署到云服务器

本系统为**零第三方依赖的 Node.js 应用**，数据持久化在本地 JSON 文件。云服务器有持久磁盘 + 常驻进程，正好契合当前架构，**代码一行都不用改**即可上线。

---

## 一、准备云服务器

1. 购买一台 Linux 云服务器（Ubuntu 22.04 / 腾讯云 TencentOS / 阿里云 Alibaba Cloud Linux 均可，1 核 1G 足够）。
2. **安全组放行端口**：云厂商控制台 → 安全组 → 入站规则
   - 方案 A（裸跑）：放行 TCP `3000`
   - 方案 B（Nginx 反代 + 域名）：放行 TCP `80` 和 `443`
   - 服务器本地防火墙（若开了 `ufw`）：`sudo ufw allow 3000/tcp`

---

## 二、安装 Node.js（≥ 16，推荐 20 LTS）

```bash
# Ubuntu / Debian
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # 确认 >= 16
```

---

## 三、上传项目

项目只需这些文件即可运行：

```
server.js            # 主程序（已内置自动建 27 班、优雅关闭、访问日志）
public/              # 前端（index.html / app.js / styles.css）
lib/xlsx-export.js   # 餐费核对表 xlsx 生成器
school-classes.json # 全校班级清单（来源：工作安排表）
package.json
data/               # 含当前 data.json（27 个班）。不传也能自动建班
deploy/             # 部署脚本与配置（可选，但建议带上）
```

### 方式 1：一键部署脚本（推荐）

在本机项目根目录执行（需本地有 `ssh`/`scp` 且能免密登录服务器；不能免密会把密码交互提示出来）：

```bash
bash deploy/deploy.sh root@服务器IP:/opt/class-meal-system
```

脚本会：本地打包（自动排除 `node_modules`/`.shots`/调试脚本）→ scp 上传 → 解压（**保留线上 `data/` 数据，不覆盖**）→ 调用 `start.sh` 重启。

### 方式 2：手动 scp

```bash
# 在本机执行（排除无关文件）
tar --exclude='./node_modules' --exclude='./.shots' --exclude='./deploy' \
    --exclude='./gen-xlsx.py' --exclude='./shot-mobile.js' --exclude='./test-smoke.js' \
    -czf meal.tar.gz -C class-meal-system .
scp meal.tar.gz root@服务器IP:/opt/
ssh root@服务器IP "mkdir -p /opt/class-meal-system && tar -xzf /opt/meal.tar.gz -C /opt/class-meal-system"
```

### 方式 3：Git

```bash
git clone <你的仓库>
cd class-meal-system && bash deploy/start.sh
```

> **关于 27 个班**：部署后首次启动（若服务器上没有 `data.json`）会自动从 `school-classes.json` 生成全校 27 个班。若你上传了本机的 `data.json`，则沿用其中的班级，不会重复创建。

---

## 四、启动（三选一）

### A. pm2（最省心，推荐）

```bash
sudo npm i -g pm2
cd /opt/class-meal-system
pm2 start server.js --name meal
pm2 save                 # 保存进程列表
pm2 startup              # 按提示执行它给出的命令，实现开机自启
pm2 logs meal            # 看日志
```

### B. systemd（不装额外依赖，生产规范）

```bash
sudo useradd -r -s /usr/sbin/nologin -d /opt/class-meal-system meal
sudo chown -R meal:meal /opt/class-meal-system
sudo cp deploy/meal.service /etc/systemd/system/meal.service
sudo systemctl daemon-reload
sudo systemctl enable --now meal
sudo journalctl -u meal -f   # 看日志
```

`meal.service` 默认 `HOST=127.0.0.1`，需配合下方 Nginx 反代。

### C. nohup（临时 / 测试）

```bash
cd /opt/class-meal-system
HOST=0.0.0.0 PORT=3000 nohup node server.js > /var/log/meal.log 2>&1 &
```

---

## 五、Nginx 反代 + HTTPS + 域名（生产推荐）

直接暴露 `:3000` 是裸 HTTP。建议加域名和 HTTPS：

```bash
sudo apt install nginx
sudo cp deploy/meal.nginx.conf /etc/nginx/sites-available/meal
sudo ln -s /etc/nginx/sites-available/meal /etc/nginx/sites-enabled/meal
# 编辑 meal.nginx.conf，把 server_name 改成你的域名
sudo nginx -t && sudo systemctl reload nginx

# 申请免费证书（自动改写配置并续期）
sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d meal.your-domain.com
```

之后访问 `https://meal.your-domain.com`。此时服务应只监听 `127.0.0.1`（pm2 启动前设 `HOST=127.0.0.1`，或 systemd 已设）。

---

## 六、上线必做

1. **改默认密码**：浏览器打开系统 → 「系统设置」页，把管理密码 `admin` 改掉（否则任何人可删数据）。
2. **导入学生**：「学生管理」页录入/批量导入各班学生与 9 月就餐记录。
3. **导出核对表**：「统计报表」页 → 「导出全校餐费核对表」，得到每班一工作表的多页 xlsx。

---

## 七、数据备份（学校系统必需）

所有数据在 `data/data.json`（另有 `data.json.bak` 自动备份）。定期备份该目录：

```bash
cp -r /opt/class-meal-system/data /backup/meal-data-$(date +%F)
```

`deploy/deploy.sh` 每次更新都会先把线上 `data/data.json` 另存为 `data/data.json.pre-deploy-<时间戳>` 再覆盖代码，避免误删数据。

---

## 八、日常运维

| 操作 | 命令 |
|---|---|
| 看日志(pm2) | `pm2 logs meal` |
| 看日志(systemd) | `sudo journalctl -u meal -f` |
| 重启 | `pm2 restart meal` 或 `sudo systemctl restart meal` |
| 更新代码 | 在本机改完跑 `bash deploy/deploy.sh ...`（自动保留数据） |
| 修改端口/监听 | 环境变量 `PORT` / `HOST`（pm2 `--update-env` 或改 `meal.service` 的 `Environment`） |

---

## 九、故障排查

- **端口被占用**：`sudo lsof -i:3000` 查占用进程；或换 `PORT=8080`。
- **安全组没放行**：本机 `curl http://服务器IP:3000/api/state` 若超时，先在云控制台放行端口。
- **权限报错（systemd）**：确认 `meal` 用户对 `/opt/class-meal-system/data` 有写权限（`chown -R meal:meal`）。
- **数据损坏**：服务会自动把损坏文件另存为 `data/corrupted-*.json` 并回退到 `data.json.bak`；必要时用备份替换 `data.json` 后重启。
