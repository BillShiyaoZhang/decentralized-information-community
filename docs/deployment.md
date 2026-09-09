# 开发、部署与迁移

## Docker 开发

```sh
docker compose up -d dev
docker compose logs -f dev
docker compose exec -T dev npm test
```

页面位于 `http://localhost:4173`。源码从本仓库挂载，输出在 `dist/`。静态数据和页面修改触发重新构建，手动刷新浏览器。核心或开发脚本变更后如没有重启日志，执行 `docker compose restart dev`。

```sh
docker compose stop dev
```

停止开发服务不删除本机浏览器草稿。

## GitHub Pages

1. 将仓库推送到自己的 GitHub 项目。
2. 在 Settings → Pages → Build and deployment 中选择 GitHub Actions。
3. 在 Actions 手动运行 `Publish GitHub Pages`。

工作流测试后构建 `dist/`，使用 GitHub 官方 Pages Actions 上传部署。初版选择手动发布，避免每个代码提交自动改变社区公开内容；后续可以按团队流程增加 `push` 触发。

也可将 `npm run build` 的 `dist/` 部署到任意静态 HTTP 服务。入口、模块和数据均使用相对 URL，支持 `https://user.github.io/repository/` 子路径；不要直接用 `file://` 打开 ES modules。

本次开发中的 `.openai/hosting.json` 仅用于可选的私有演示托管，与核心、Pages 和 Docker 运行无关。克隆用于独立项目时，删除该演示配置或注册自己的站点，不要复用别人的站点 ID。

## 维护者合并静态提案

贡献者从页面导出 `*-proposal.json`，通过 PR 或约定渠道交给维护者。提案包含非可信内容，先审核其来源、正文、关联理由与适用范围，再在独立分支运行：

```sh
npm run apply -- examples/campus/graph.json proposal.json examples/campus/graph.json
npm run validate
npm test
npm run build
```

检查数据 diff 后合并 PR，再发布。`apply` 对输出文件使用独占锁、锁内版本检查和原子替换；同时提交只会成功一个，其余报告冲突或锁占用。进程异常退出可能留下 `.lock`，确认没有合并进程且已备份后人工清除。不要仅修改提案的 `baseRevision` 来跳过真实冲突。

要输出到新路径，指定不存在的文件名；若输出已存在，请使用同一输入／输出路径以获得正确的当前版本检查。

本版没有自动把 Issue 转成可信写入的工作流；验证不会代替人工内容审核。

## 私有服务器

在启动服务器的环境中设置随机 `WRITE_TOKEN`。不要把实际令牌写入版本控制。PowerShell 可用：

```powershell
$env:WRITE_TOKEN = [Convert]::ToHexString([Security.Cryptography.RandomNumberGenerator]::GetBytes(32))
docker compose --profile server up -d --build server
```

通过安全方式把令牌交给编辑者，在 `http://localhost:4174` 的“设置写入令牌”中输入。没有令牌也能浏览，不能保存。

容器以非 root 的 node 用户运行。`community-data` volume 保存数据库，`docker compose --profile server stop server` 或容器重建不会删除数据。**`docker compose down -v` 会删除 volume，不要把它当作普通停止命令。**

不使用 Docker 时：

```sh
npm run build
npm start
```

环境变量：`HOST` 默认 `127.0.0.1`，`PORT` 默认 4173，`DATA_DIR` 默认 `.runtime`，`GRAPH_FILE` 默认 `examples/campus/graph.json`。仅在数据库为空时导入种子。已有数据库不能通过覆盖种子来更新，使用提案 API；切换社区必须使用新的 `DATA_DIR`。

线上运行应通过 HTTPS 反向代理，限制请求频率并做好备份。默认 Bearer 令牌只提供全社区写权限，不是细粒度授权。`author` 可由投稿者自填，不是认证身份。生产集成应接入产品已有的登录、审核和审计体系。

## 从服务器导出静态站

本机运行时：

```sh
npm run snapshot -- .runtime/community.sqlite exported-graph.json
```

Docker 运行时：

```sh
docker compose --profile server exec -T server node scripts/snapshot.mjs /data/community.sqlite /tmp/exported-graph.json
docker compose --profile server cp server:/tmp/exported-graph.json ./exported-graph.json
```

然后将 `GRAPH_FILE` 指向该文件再构建。快照保留原社区 ID、revision、蓝图、节点、关系；它不包含 SQLite 历史记录或认证配置。浏览器“下载当前快照”也能导出当前可见状态，在静态模式下其中可能包含尚未经审核的本机内容。

从静态转服务器时，令 `GRAPH_FILE` 指向已审核快照，并使用全新的数据目录。备份整个历史应使用 SQLite 正规备份流程；不要在写入中的 WAL 数据库上只复制主文件。
