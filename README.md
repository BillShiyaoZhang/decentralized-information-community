# 共知 · Information Community

把社区的话题、经验和资料连接成可检索的知识网络。核心不依赖框架、数据库或托管商；同一份数据既能部署成 GitHub Pages 静态站，也能在私有服务器上持续写入和计算。

这是对 [最初想法](docs/intent.md) 的首个可运行实现。设计判断、取舍和后续边界见 [方案评估](docs/assessment.md)。校园数据均为演示，不代表学校现行规定。

## 先看效果

需要 Docker Desktop 或 Docker Engine + Compose。

```sh
docker compose up -d dev
```

打开 <http://localhost:4173>，尝试：

1. 搜索“新生”，在卡片与关系图之间切换。
2. 点击“贡献内容”，创建话题或经验，然后在详情中用 `+` 建立有理由的关联。
3. 在“类型与关系蓝图”中查看当前领域约束。
4. 在“数据与提案”中导出本机修改或完整快照。

修改 `web/`、`packages/` 或 `examples/` 后会重新构建；刷新页面看结果。修改服务器源码或开发脚本后可 `docker compose restart dev`。

只有 Node.js 也可运行（要求 Node 24.12.x 或更新的 24.x）：

```sh
npm run dev
```

没有第三方运行时依赖，也不需要 `npm install`。代码使用原生 ES modules，Node 内置测试、HTTP 和 SQLite；本版本 Node 的 SQLite API 仍属实验性，生产升级前应复验。

## 两种运行方式

| 能力 | 静态站点 | 私有服务器 |
| --- | --- | --- |
| 检索、内容详情、关系图、蓝图校验 | 支持 | 支持，共用同一核心 |
| 保存贡献 | 当前浏览器的本机草稿 | SQLite 事务写入 |
| 共享更新 | 导出提案 → PR 审核 → 构建发布 | 携带写入令牌的 API |
| 历史 | Git 提交记录 | 不可变快照与提案日志 |
| 服务端计算 | 无 | 检索、邻域与连接统计接口，可扩展 |
| 数据迁移 | 下载 JSON 快照 | 从 SQLite 导出相同格式快照 |

**静态模式没有自动多人同步。** 浏览器草稿、未经审核的下载快照都不等于已发布社区数据。服务器默认公开读取、禁止写入；配置令牌后，持令牌者拥有整个社区的写权限。这不是完善的用户账号与审核系统。

启动私有服务器：

```sh
# 在当前环境设置 WRITE_TOKEN，使用足够长的随机值，不要提交到 Git。
docker compose --profile server up -d --build server
```

打开 <http://localhost:4174>。未设置 `WRITE_TOKEN` 时服务器只读。设好令牌后在页面“设置写入令牌”中输入；令牌只保留在当前页面内存。数据库保存在 `community-data` Docker volume，重新创建容器不会丢失。外网部署应使用 HTTPS 和适当的访问控制。

详细操作见 [部署与迁移](docs/deployment.md)。

## 用于自己的项目

替换 JSON 中的 `ontology` 和内容，不需要修改核心。例如同样的页面可以显示“问题 / 决策 / 依据”：

```sh
# POSIX shell
GRAPH_FILE=examples/decisions/graph.json npm run dev
```

```powershell
# PowerShell
$env:GRAPH_FILE = 'examples/decisions/graph.json'
npm run dev
```

从校园演示切到决策库前先停止占用同一端口的进程。Docker 可执行：

```sh
docker compose stop dev
docker compose run --rm --service-ports -e GRAPH_FILE=examples/decisions/graph.json dev
```

核心也可以直接导入自己的应用：

```js
import { validateGraph, searchGraph, makeChange, applyChange } from './packages/core/index.js';

validateGraph(graph);
const matches = searchGraph(graph, { query: '新生', type: 'topic' });
const proposal = makeChange(graph, [{ op: 'putNode', value: myNode }]);
const next = applyChange(graph, proposal); // 校验失败或版本过期时，不修改原图
```

请参考 [架构与数据契约](docs/architecture.md)、[接入新业务](docs/extending.md)、[投稿与审核](CONTRIBUTING.md)。

## 验证

```sh
docker compose exec -T dev npm test
docker compose exec -T dev npm run validate
docker compose exec -T dev npm run build
```

测试覆盖类型约束、无效来源、关系完整性、中文搜索、跨标签页冲突、草稿恢复、SQLite 历史、API 权限与版本冲突、CLI 并发合并、快照迁移，以及 GitHub Pages 仓库子路径。测试使用临时数据库，不触及实际社区数据。

GitHub Actions 自动运行检查。Pages 发布通过手动工作流启用，见部署文档。

## 项目结构

```text
packages/core/       纯函数领域核心：蓝图、图验证、提案、搜索与图计算
packages/adapters/   静态草稿 / HTTP 存储适配器
server/             Node HTTP API + SQLite 不可变快照
web/                不依赖框架的参考界面
examples/           校园指南 / 项目决策库
scripts/            构建、开发预览、验证、合并提案、导出快照
tests/              核心、API、CLI 和静态部署验证
docs/               评估、架构、接入与部署说明
```

## 当前边界

这是一份可扩展基础，不是联邦协议：没有 P2P 自动同步、账户系统、细粒度权限、审核队列、全文搜索服务或 OWL 推理；首版也没有删除／撤回协议。全图版本冲突采用保守拒绝策略，不自动猜测如何合并。大数据量应接入索引和专门的图布局；当前上限为 10000 节点 / 40000 关系，推荐用小型社区先验证模式。

许可证：[MIT](LICENSE)。
