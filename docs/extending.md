# 接入自己的业务

需要复用身份、发布、不可变证据或私有队列的应用，可采用新的 [runtime 固定产物](runtime.md)。下文关于由业务服务器自行执行治理的约定，适用于单独使用纯图 core 的集成方式。

## 只换数据和蓝图

从 `examples/campus/graph.json` 或 `examples/decisions/graph.json` 复制一份，设置独立社区 `id`，再定义类型。

例如校园业务的 `topic` / `note` / `resource`，可以换成决策业务的 `problem` / `decision` / `evidence`。界面菜单、表单必填项、关系选择和标签根据 ontology 生成，不硬编码业务类型。节点的第一种类型在图里使用较大的圆点，这只是参考界面的视觉约定。

默认用户内容位于 `content/graph.json`。运行 `npm run validate -- your-graph.json` 验证，再修改 `community.config.json` 的 `graphFile` 和品牌文案；Pages 与 Docker 共用配置。临时预览可用 `GRAPH_FILE` 覆盖。使用相同社区 ID、revision 和数据路径会复用浏览器草稿；开发独立社区请换 ID。

## 复用核心而不用参考界面

独立依赖为 `@information-community/core`。在本仓库执行 `npm run package:core`，将生成的 `.tgz` 复制进使用方仓库并安装，然后从包名导入。包附带 TypeScript 类型，没有运行时依赖，无需本仓库的服务器、界面或数据库。目前未发布 npm registry，详见 [包文档](../packages/core/README.md)。

- `validateOntology` / `validateGraph`：校验类型蓝图与完整图。
- `makeChange` / `applyChange`：构造和原子应用带版本约束的提案。
- `diffGraphs`：把草稿转换为相对已发布基线的累计提案，拒绝删除和元数据差异。
- `searchGraph`：可替换的基础中文子串搜索。
- `neighborhood` / `graphStats`：可在客户端和服务器运行的基础图计算。

适配器约定：`load(): Promise<Graph>`，`commit(change): Promise<Graph>`。你可以在业务应用中替换 StaticAdapter / HttpAdapter；不要把浏览器写入令牌打包进静态资源。

## 校园指南接入建议

1. 从既有产品的公开数据投影稳定节点与关系，保留原业务 ID 映射。
2. 私密、已撤回、未发布数据不可直接导出到静态图中。
3. 原有的逐句证据、适用范围、负责人和复核期限继续留在业务系统；可以附加字段，但要由业务 schema 负责验证。
4. 在业务服务器接收 Change 后，先做身份、授权、证据与发布策略检查，再保存 canonical 数据并重新生成公开图。
5. 当前图的边绑定稳定节点 ID，不绑定具体内容修订。需要固定版本引用的产品应先扩展协议，不得把本原型当成既有修订模型的直接替代。

已在 `xjtlu-unofficial-guide` 的 `/answers/[slug]` 真实页面接入“同主题其他答案”：以原业务层筛选出的公开候选构建有限的只读图，用两跳邻域查找关联答案，并继续渲染原卡片。没有迁移或替换原数据库、证据与审核流程。映射和验证细节见 [校园集成](integrations/xjtlu-unofficial-guide.md)。

## 数据与协议演进

新增协议版本时，显式修改 `schemaVersion` 并提供旧版迁移函数，不静默猜测格式。服务端持有原始提案和不可变快照，后续可以增加发布状态、撤回投影、逐节点修订、审核策略等。

如果需要 JSON-LD / RDF，增加独立导出器，为类型和关系分配稳定 URI，再验证往返映射。当前轻量图协议不是 OWL ontology，也不会做语义推理。
