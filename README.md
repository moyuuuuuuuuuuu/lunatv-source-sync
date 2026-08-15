# LunaTV Source Sync

一个面向单管理员私有部署的 LunaTV 影视源管理器。它提供 JSON 导入与同键覆盖、成人源分类、定时健康检查、JSON/Base58 订阅，以及只允许访问数据库内已启用来源的受控 CORS 代理。

## 快速启动

要求 Docker Compose，目标平台固定为 `linux/amd64`（群晖 Intel/AMD 机型可直接运行；ARM 机型需要模拟，性能与兼容性不作保证）。

```bash
cp .env.example .env
# 编辑 .env，至少替换管理员密码和 SESSION_SECRET
mkdir -p data
sudo chown 1000:1000 data
docker compose up -d --build
```

打开 `http://NAS地址:3000/` 登录。运行状态可用 `curl http://NAS地址:3000/health` 检查，日志用 `docker compose logs -f` 查看。

务必使用随机且互不相同的密钥，例如：

```bash
openssl rand -hex 32
```

`ADMIN_USERNAME`、`ADMIN_PASSWORD`、`SESSION_SECRET` 和 `SUBSCRIPTION_TOKEN` 只通过环境变量提供，不会存入数据库。若 `SUBSCRIPTION_TOKEN` 留空，订阅接口允许匿名访问。

## 群晖部署

在 File Station 创建例如 `/volume1/docker/lunatv-source-sync`，并在其下创建 `data`。通过 SSH 将本仓库放入该目录，复制 `.env.example` 为 `.env`，填写强密码和随机密钥，然后运行：

```bash
cd /volume1/docker/lunatv-source-sync
sudo chown 1000:1000 data
chmod 700 data
docker compose up -d --build
```

Container Manager 用户也可导入 `docker-compose.yml` 项目；项目目录必须包含 `.env`，并将宿主机 `./data` 映射到 `/app/data`。镜像最终以非 root 的 UID/GID `1000:1000` 运行，因此宿主目录需对该 UID 可写。也可通过 `DATA_DIR=/volume1/...` 指定绝对数据目录。仅对可信局域网开放 3000 端口，公网使用 HTTPS 反向代理。

群晖反向代理终止 HTTPS 时，把 `.env` 中以下两项同时设为 `true`，再重建容器：

```dotenv
SECURE_COOKIES=true
TRUST_PROXY=true
```

`SECURE_COOKIES=true` 使登录 Cookie 只经 HTTPS 发送；`TRUST_PROXY=true` 信任反向代理传入的协议和客户端地址。不要在服务可被不可信代理直连时开启 `TRUST_PROXY`。本机或局域网纯 HTTP 应保持两项为 `false`（默认值），否则浏览器不会回传登录 Cookie。

## 导入、分类与覆盖

管理页面接受 LunaTV `api_site` 对象。既可以选择本地 JSON 文件，也可以输入 HTTP(S) URL；URL 返回内容会自动识别为 JSON 或 Bitcoin Base58 编码的 JSON。远程拉取会拒绝私网、回环、链路本地和元数据地址，并限制重定向、超时与响应大小。导入预览会逐项报告错误；确认导入后，以来源 key 为唯一键：同 key 更新名称、API、备注和分类，但保留当前健康状态与历史记录。上传原文件和远程原文都不会持久保存。

成人分类默认根据 key、名称、URL 和备注关键词自动判断。编辑来源可将分类模式显式改为“成人”或“普通”，覆盖自动判断；`ADULT_KEYWORDS_EXTRA` 可添加逗号分隔的自定义关键词。

新来源和未检查来源会发布。连续失败达到“失败阈值”后从订阅隐藏，后续检查成功会自动恢复；“忽略检测”来源始终按启用状态发布。检测周期、超时、失败阈值与缓存时间可在设置页修改，也可手动触发单源、批量或全局检测。容器内调度器会自动运行，无需 cron。

## 订阅与代理

常用地址（配置 token 后必须附带）：

```text
/api/source?ac=list&source=normal&format=json&proxy=0&token=YOUR_TOKEN
/api/source?ac=list&source=adult&format=json&proxy=0&token=YOUR_TOKEN
/api/source?ac=list&source=all&format=base58&proxy=0&token=YOUR_TOKEN
/api/source?ac=list&source=normal&format=json&proxy=1&token=YOUR_TOKEN
```

`source` 仅接受 `normal`、`adult`、`all`，`format` 仅接受 `json`、`base58`。`proxy=1` 会把订阅里的 API 地址改写到 `/api/proxy/:sourceKey`。该代理不能传入任意 URL，只代理数据库中已启用的来源，并拒绝私网、回环、链路本地及元数据地址；它不是通用反向代理。

轮换订阅 token：修改 `.env` 的 `SUBSCRIPTION_TOKEN`，运行 `docker compose up -d --force-recreate`，再同步更新所有 LunaTV 客户端。旧地址会立即失效。轮换 `SESSION_SECRET` 会立即使所有管理会话失效，需要重新登录。

## 备份与恢复

所有持久数据位于 `data/app.db`。SQLite 使用 WAL；推荐先停止服务再复制整个 `data` 目录，确保备份一致：

```bash
docker compose stop
tar -czf "lunatv-source-sync-$(date +%F).tgz" data
docker compose start
```

恢复时先 `docker compose down`，保留当前目录的安全副本，再用备份替换 `data`。`.env` 含凭据，应单独加密备份，切勿提交 Git。

## 升级与回滚

升级前备份 `data` 和 `.env`，拉取新版本后重建：

```bash
docker compose down
git pull --ff-only
docker compose build --pull
docker compose up -d
docker compose ps
```

启动时会自动执行数据库迁移。需要回滚时，停止容器、切回已知可用版本，并同时恢复升级前数据库备份；不要让旧程序直接打开已由新版本迁移的数据库。

## 排障

- 容器反复退出：检查 `docker compose logs`；确认三个必填变量（管理员用户名、密码、会话密钥）非空、`data` 可由容器内非 root 用户写入、3000 端口未占用。
- 登录成功后仍显示未登录：纯 HTTP 下确认 `SECURE_COOKIES=false`；HTTPS 反向代理下确认两项代理配置为 `true`，并传递 `X-Forwarded-Proto: https`。
- 返回 401：管理 API 需要登录会话；订阅/代理需要当前 `SUBSCRIPTION_TOKEN`。修改 token 后客户端旧链接会失效。
- 来源没有出现在订阅：检查来源是否启用、分类筛选是否匹配，以及连续失败数是否达到阈值；查看健康历史后可手动重检。
- 代理返回 502/504：上游不可达、响应过大、超时或解析失败；指向内网及特殊地址的源会被安全策略拒绝。
- 群晖提示镜像架构不符：本项目只构建 `linux/amd64`，确认 NAS 是 Intel/AMD 架构。
- 数据库无法打开：确认 `./data:/app/data` 映射存在和权限正确，不要把数据库放在不支持 SQLite 锁语义的网络文件系统上。

## 本地开发与验证

需要 Node.js 22：

```bash
npm ci
npm test
npm run typecheck
npm run build
npm audit --omit=dev
```

完整容器冒烟测试会启动独立 Compose 项目并在结束后清理：

```bash
bash scripts/smoke-test.sh
```
