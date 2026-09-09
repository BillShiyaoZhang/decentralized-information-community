# 部署与迁移

## GitHub 模板与 Pages

维护者在源仓库 **Settings → General → Template repository** 勾选模板属性即可出现 **Use this template**。这是 GitHub 仓库设置，不能靠提交文件启用；本地开发没有修改该设置。采用者也可 Fork 或自行复制仓库。

1. 用模板创建自己的仓库。GitHub Free 使用公开仓库；私有仓库的 Pages 可用性取决于 GitHub 套餐。
2. 新仓库 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**；Fork 若提示 Actions 已禁用，先按界面启用。
3. **Actions → Publish GitHub Pages → Run workflow**，选择默认分支。若创建仓库时的首次自动运行因尚未启用 Pages 而失败，完成第 2 步后重新运行即可。
4. 等待部署完成，点击工作流环境或摘要中的网站地址。

之后默认分支的每次 push 都运行测试、构建和 Pages 部署；功能分支只参与代码检查，不会发布，也不会取消默认分支的部署。工作流读取新仓库自己的默认分支名称，不要求名为 `main`。

首次授权 Pages 是 GitHub 平台步骤，普通 `GITHUB_TOKEN` 不能自动启用它。本项目没有要求额外配置 PAT。参见 [GitHub 模板](https://docs.github.com/en/repositories/creating-and-managing-repositories/creating-a-template-repository)、[Pages 自定义工作流](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)与 [configure-pages 的 enablement 说明](https://github.com/actions/configure-pages/blob/main/action.yml)。

工作流发布 `dist/`；入口、模块和数据使用相对 URL，支持 `https://user.github.io/repository/` 子路径。也可把 `npm run build` 的结果部署到其他静态 HTTP 服务。不要通过 `file://` 打开 ES modules。

## 配置自己的社区

`community.config.json` 是 Pages、本地预览、Docker 构建和服务器共有的入口：

- `graphFile`：相对配置文件目录的快照路径，默认 `content/graph.json`。
- `site`：品牌、英文副标题、标语、首页标题和页脚；只接受文本。
- `content/graph.json`：社区 `id`、名称、领域类型、节点与关系。创建新社区时设置新的稳定 `id`，避免复用演示草稿。

示例保留在 `examples/`；可复制决策库到 `content/graph.json`，或修改配置指向它。改内容后运行 `npm run validate`。每个部署有自己的配置与数据，无需修改核心代码。

高级覆盖：`COMMUNITY_CONFIG` 指向另一份配置，`GRAPH_FILE` 显式替换它的快照路径。两者都相对仓库根目录解析；未覆盖的 `graphFile` 相对配置目录解析。配置内路径必须在配置所在目录内；外部快照可通过 `GRAPH_FILE` 显式指定。Docker 中路径必须存在于构建上下文或挂载中。

**Compose 会读取 `.env`，普通 npm 命令只读取进程环境变量。** Pages 不使用你的本机 `.env`；跨环境共用的配置应提交到 `community.config.json`，令牌只留在服务器环境。

```powershell
# 临时本地查看另一份示例
$env:GRAPH_FILE = 'examples/decisions/graph.json'
npm run dev
# 结束后 Remove-Item Env:GRAPH_FILE
```

POSIX shell 可用 `GRAPH_FILE=examples/decisions/graph.json npm run dev`。

## 从静态站转到服务器

先将已审核公开快照放到配置所指向的文件中；浏览器尚未合并的草稿不会自动随 Git 仓库迁移。需要保留草稿时，应先导出提案并审核合并。

使用新的数据库启动时会自动导入。想先核对导入结果，可在启动前显式执行：

```sh
docker compose --profile server build server
docker compose --profile server run --rm --no-deps server npm run init:server
docker compose --profile server up -d server
```

`init:server` 输出社区 ID、revision、节点和关系数量，遇到已有数据库会拒绝覆盖。只在首次启动前运行；不要在已有服务器上当作更新或重置命令使用。默认自动初始化和显式初始化保留相同的 ID、revision、蓝图与内容。

数据库在 `community-data` 命名 volume 中；重建镜像、修改种子不会替换已有数据库。更新共享内容使用提案 API。新建另一个独立社区时使用新的 Compose 项目名（`docker compose -p another-community ...`）、端口与配置。

复制 `.env.example` 为 `.env`，填入随机 `WRITE_TOKEN`，然后运行：

```sh
docker compose --profile server up -d --build server
```

打开 <http://localhost:4174>。默认只读；设置令牌后，编辑者可在页面“设置写入令牌”中输入并提交修改。不要把真实令牌提交到 Git。

容器使用非 root 用户，带健康检查与重启策略。默认仅绑定本机 `127.0.0.1`，外网部署可在 `.env` 设置 `BIND_ADDRESS`、`SERVER_PORT` 并接 HTTPS 反向代理。API 默认公开读取；私密社区须在入口增加认证。写令牌提供全社区写权限，署名不是认证身份；实际产品应接入既有的登录、授权、审核和审计体系。

普通停止用 `docker compose --profile server stop server`。`docker compose down -v` 会删除数据库 volume，不能当作普通停止命令。

## 直接运行 Node / Docker 开发

根应用要求 Node 24.12 或更新的 24.x，使用该版本实验性的内置 SQLite API。

```sh
npm ci
npm run build
npm run init:server
npm start
```

`init:server` 可省略，首次启动也会初始化。Node 的 `HOST` 默认 `127.0.0.1`，`PORT` 默认 `4173`，`DATA_DIR` 默认 `.runtime`；Compose 镜像设置 `DATA_DIR=/data`。更换社区使用新 `DATA_DIR`。同样应在进程环境设置 `WRITE_TOKEN`。

只需静态开发预览时运行 `npm run dev` 或 `docker compose up -d dev`，地址为 <http://localhost:4173>。后者挂载本仓库并轮询配置、内容和页面变动；更新后刷新浏览器。运行完整测试前先 `npm ci` 安装开发依赖；没有本机 Node 可 `docker compose run --rm dev npm ci`。修改开发脚本后可 `docker compose restart dev`。

## 合并静态提案

维护者审核贡献者导出的提案，核对来源、正文、关联理由与适用范围后，在独立分支运行：

```sh
npm run apply -- content/graph.json proposal.json content/graph.json
npm run validate
npm test
npm run build
```

使用其他快照路径时对应替换参数。检查 diff 并合并 PR，默认分支的工作流自动发布。验证只证明格式和图结构正确，不能替代内容审核。

`apply` 使用独占锁、锁内版本检查和原子替换。进程异常退出留下 `.lock` 时，先确认没有合并进程并备份，再人工清除。不要只修改 `baseRevision` 绕过冲突。输出到新路径应使用不存在的文件名；输出已存在时，输入和输出须是同一路径。

## 从服务器导出静态镜像

本机运行：

```sh
npm run snapshot -- .runtime/community.sqlite exported-graph.json
```

Docker 运行：

```sh
docker compose --profile server exec -T server node scripts/snapshot.mjs /data/community.sqlite /tmp/exported-graph.json
docker compose --profile server cp server:/tmp/exported-graph.json ./exported-graph.json
```

将导出文件审核后放回配置指定的路径，或通过 `GRAPH_FILE` 指向它，再构建静态站。快照保留社区 ID、revision、蓝图、节点与关系，不含 SQLite 历史或认证配置；静态镜像不会自动持续同步服务器。

页面“下载当前快照”也能导出当前可见状态，静态模式下可能包含本机未审核内容。备份全部历史应采用 SQLite 备份流程，不要在写入中的 WAL 数据库上只复制主文件。
