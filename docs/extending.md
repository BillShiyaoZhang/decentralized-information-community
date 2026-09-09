# 接入自己的业务

## 只换数据和蓝图

从 `examples/campus/graph.json` 或 `examples/decisions/graph.json` 复制一份，设置独立社区 `id`，再定义类型。

例如校园业务的 `topic` / `note` / `resource`，可以换成决策业务的 `problem` / `decision` / `evidence`。界面菜单、表单必填项、关系选择和标签根据 ontology 生成，不硬编码业务类型。节点的第一种类型在图里使用较大的圆点，这只是参考界面的视觉约定。

运行 `npm run validate -- your-graph.json` 验证，再设置 `GRAPH_FILE` 构建或启动。使用相同社区 ID、revision 和数据路径会复用浏览器草稿；开发独立社区请换 ID。

## 复用核心而不用参考界面

纯函数入口是 `packages/core/index.js`：

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

这个仓库没有自动迁移或修改 QandA / 校园指南的数据。它先证明共用核心的可行性，真实接入应通过明确映射和回归检查完成。

## 数据与协议演进

新增协议版本时，显式修改 `schemaVersion` 并提供旧版迁移函数，不静默猜测格式。服务端持有原始提案和不可变快照，后续可以增加发布状态、撤回投影、逐节点修订、审核策略等。

如果需要 JSON-LD / RDF，增加独立导出器，为类型和关系分配稳定 URI，再验证往返映射。当前轻量图协议不是 OWL ontology，也不会做语义推理。
