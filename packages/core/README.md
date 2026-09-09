# @information-community/core

无运行时依赖的 ESM 核心包：校验社区蓝图与知识图、接纳带版本检查的提案、搜索和邻域查询。可用于 Node 22.13+、现代浏览器和支持这些 Web API 的运行环境；不依赖 SQLite、Docker、参考 UI 或任何托管商。

本版本尚未上传 npm registry。维护者在项目根运行 `npm run package:core` 后，其他项目可以独立安装产出的压缩包：

```sh
npm install ./information-community-core-0.2.0.tgz
```

```ts
import { validateGraph, searchGraph, neighborhood, type Graph } from '@information-community/core';

const graph: Graph = validateGraph(await response.json());
const matches = searchGraph(graph, { query: '新生', type: 'topic' });
const nearby = neighborhood(graph, 'arrival', 1);
```

公开函数：`validateOntology`、`validateGraph`、`safeUrl`、`makeChange`、`applyChange`、`diffGraphs`、`searchGraph`、`neighborhood`、`graphStats`；错误类型 `GraphError`。TypeScript 类型通过标准 exports 入口提供。

调用 `makeChange` 未传 ID 时，需要 `crypto.randomUUID()`；浏览器应使用 HTTPS 或 localhost。传入自己的合法提案 ID 也可避免使用随机 ID API。

Graph/Change 的 `schemaVersion` 当前为 1。只接纳 JSON 数据，包括扩展字段；函数、Date 实例、BigInt、循环引用和非有限数字会被拒绝。业务层须自行验证扩展字段的含义以及身份、证据和发布权限。

`applyChange` 先复制图，再验证完整结果；失败不修改原图。`validateGraph` 返回原对象；搜索和邻域返回对原节点/关系的引用，不会冻结数据。请勿通过修改返回引用绕过提案流程。

`diffGraphs` 只处理节点和关系的新增或替换。没有变化时会返回空 operations，调用方应提示无需提交；蓝图、社区元数据和删除操作不属于本提案协议。关系引用稳定节点 ID，尚不支持固定内容修订。

0.x 版本期间，升级前查看仓库 CHANGELOG。包与参考应用分别声明运行时要求；服务器使用 Node 24 的 SQLite API，不影响本包的使用。
