# 共知 · Information Community

一个可自托管的社区知识网络工具：把话题、经验和资料连接起来，让小型社区能检索、补充和维护自己的知识。

**一个仓库，两条上手路径。** 先复制模板获得 GitHub Pages 网站，需要共享写入时再运行同仓库的服务器；已有应用可以单独安装 `@information-community/core`。

校园内容目前保留为演示，不代表学校现行规定。真实校园指南继续在 `xjtlu-unofficial-guide` 中维护，已有一个[真实页面接入示例](docs/integrations/xjtlu-unofficial-guide.md)。[原始想法](docs/intent.md)与[设计评估](docs/assessment.md)说明项目的出发点。

## 第一阶段：复制模板，发布自己的网页

1. 在 GitHub 点 **Use this template → Create a new repository**。若源仓库还未启用模板，可先 Fork；维护者启用方法见[部署文档](docs/deployment.md)。
2. 新仓库的 **Settings → Pages → Build and deployment → Source** 选择 **GitHub Actions**。
3. 在 **Actions → Publish GitHub Pages → Run workflow** 选择默认分支运行，完成后工作流会显示网站地址。
4. 编辑 `community.config.json` 的品牌文案、`content/graph.json` 的社区名称、蓝图和内容。之后每次合并到默认分支都会测试、构建并自动更新 Pages。

无需服务器、数据库或自建访问令牌。GitHub 要求新仓库首次启用 Pages，因此首次使用仍有上面的设置步骤。

默认页支持搜索、内容卡片、关系图、贡献表单和提案导出。**静态模式下，贡献保存在当前浏览器，公开更新由维护者审核提案并合并进 Git。** 它不提供自动多人同步。

## 第二阶段：在自己的服务器运行

也可以直接从这一阶段开始。安装 Docker Engine / Docker Desktop 和 Compose，在仓库目录运行：

```sh
docker compose --profile server up -d --build server
```

打开 <http://localhost:4174>。构建和服务器使用同一份 `community.config.json` 与 `content/graph.json`，首次启动自动导入，SQLite 保存在 `community-data` volume 中。已有数据库不会被种子文件覆盖。

复制 `.env.example` 为 `.env`，为 `WRITE_TOKEN` 设置随机值，再重新创建服务器即可允许编辑者写入。页面中的“设置写入令牌”只将令牌保留在当前页面内存。`.env` 不要提交到 Git。

| 能力 | GitHub Pages | 私有服务器 |
| --- | --- | --- |
| 搜索、关系图、蓝图校验 | 支持 | 支持，共用核心 |
| 保存贡献 | 本机草稿，导出提案 | 带写入令牌的 API，SQLite 事务 |
| 发布流程 | 人工审核 → PR → 自动部署 | 持令牌者直接更新共享数据 |
| 历史记录 | Git 提交 | 不可变快照与提案日志 |
| 迁移 | 已审核 JSON 可作为服务器初始数据 | 导出同格式 JSON，构建静态镜像 |

服务器默认公开读取、禁止写入；配置令牌后持有者具有全社区写权限。实际账号、细粒度授权和审核流程由接入的业务系统负责。外网部署、显式导入和导出操作见[部署与迁移](docs/deployment.md)。

## 已有应用：独立使用核心包

核心包没有运行时依赖，包含 ESM 入口和 TypeScript 类型，支持现代浏览器与 Node ≥22.13。根应用的 SQLite 服务器使用 Node 24.12 或更新的 24.x。

目前通过仓库打包产物分发，尚未发布到 npm registry：

```sh
# 在本仓库（Node 24.12+ 的 24.x）
npm ci
npm run package:core
# 将 artifacts/information-community-core-0.2.0.tgz 复制进使用方项目，再执行
npm install ./vendor/information-community-core-0.2.0.tgz
```

```js
import { validateGraph, searchGraph, neighborhood } from '@information-community/core';

validateGraph(graph);
const matches = searchGraph(graph, { query: '新生' });
const related = matches.length ? neighborhood(graph, matches[0].id, 2) : null;
```

`xjtlu-unofficial-guide` 的答案详情页已采用这条路线：从公开答案投影 `答案 → 主题 ← 答案`，展示“同主题其他答案”，复用原有卡片的证据与复核提示。[包 API](packages/core/README.md)、[接入说明](docs/extending.md)、[校园集成](docs/integrations/xjtlu-unofficial-guide.md)。

## 本地开发与验证

```sh
npm ci
npm run dev
# http://localhost:4173
npm test
npm run validate
npm run build
npm run package:core
```

只看页面也可以 `docker compose up -d dev`。开发服务器会检测配置、内容、页面与核心变动，重新构建后刷新浏览器。运行测试前需要安装开发依赖；运行时本身不依赖第三方库。没有本机 Node 时，先 `docker compose run --rm dev npm ci`，再 `docker compose exec -T dev npm test`。

测试涵盖版本冲突、草稿恢复、API 权限、SQLite 历史、CLI 并发、静态仓库子路径、配置与数据往返迁移，以及将打包产物安装到仓库外的真实消费测试。CI 另在 Node 22.13 验证核心。

## 仓库结构与维护

```text
community.config.json  社区入口、品牌与页面文案
content/               用户自己的已审核社区快照
packages/core/         可独立分发的核心包与类型
packages/adapters/     静态草稿 / HTTP 适配器（参考应用内部）
web/                   无框架的参考界面
server/                Node HTTP API + SQLite
examples/              校园 / 决策库示例与测试夹具
scripts/               构建、校验、提案合并、导入、导出、打包
```

日常内容放在 `content/`，站点设置放在 `community.config.json`，升级引擎时保留这两处。模板生成的仓库是独立项目，不会自动接收上游更新；需要 GitHub 的上游同步功能可选择 Fork。核心包则通过版本号、打包产物和使用方 lockfile 升级。贡献代码和内容见 [CONTRIBUTING.md](CONTRIBUTING.md)。

目前没有 P2P / 联邦同步、删除撤回协议、账户系统、审核队列或 OWL 推理。全图版本冲突保守拒绝。上限为 10000 节点 / 40000 关系，适合先验证小型社区。[架构与数据契约](docs/architecture.md)描述具体边界。

许可证：[MIT](LICENSE)。
