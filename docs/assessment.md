# 对 intent.md 的评估

结论：**想法合理，最值得抽象的是可移植的数据契约与贡献流程。** 静态站点与服务器共享核心，业务系统负责自己的发布治理，可减少像校园指南这样的项目重复实现检索、内容关联和存储转换的成本。

## 实际参照

- [QandA schema](https://github.com/BillShiyaoZhang/QandA/blob/main/src/lib/schema.ts) 和 [公开图投影](https://github.com/BillShiyaoZhang/QandA/blob/main/src/lib/graph.ts) 已包含内容、修订、来源、有理由的关系、撤回后公开投影等概念。[投稿归集工作流](https://github.com/BillShiyaoZhang/QandA/blob/main/.github/workflows/intake.yml) 展示了通过 Issue Forms / Actions 更新静态内容的路线。
- `xjtlu-unofficial-guide` 的公开 GitHub API 在评估时返回 404。因此校园项目分析依据本机同名项目的 `README.md` 和 `apps/web/db/schema.ts`，没有假定远程内容。该模型包含 Topic、AnswerCard、不可变 Revision、适用范围、逐句证据与复核治理；这些业务规则不能因为接入新核心而被绕过。
- [GitHub Pages 官方说明](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages) 将 Pages 定义为 HTML/CSS/JavaScript 静态托管。浏览器可计算和编辑本机状态，但共享写入需要 Git/PR/Actions 或服务端。

## 采用的设计

1. **类型蓝图与数据分离。** Ontology 声明节点类型、必填正文／来源及关系端点约束；具体节点与有类型的边构成 knowledge graph。使用轻量 JSON，暂不引入 RDF 存储或 OWL 推理。[RDF Primer](https://www.w3.org/TR/rdf11-primer/) 与 [JSON-LD](https://www.w3.org/TR/json-ld11/) 可作为后续互操作方向，本版不宣称符合其序列化规范。
2. **静态优先、双适配器。** 浏览器从公开快照创建草稿并导出提案；HTTP 适配器将同一提案交给 SQLite 事务。服务器可导出为同样的静态快照。
3. **明确版本冲突。** 每个提案绑定社区 ID 和基础 revision；不匹配就拒绝，避免静默覆盖。Git 保留静态历史，SQLite 保留每次接纳后的完整快照与原始提案。
4. **领域规则留在业务层。** 校园指南的证据定位、适用范围、复核期限、发布审核等，应在业务系统映射公开数据、接受提案之前执行。
5. **可见的复用证明。** 校园指南和项目决策库采用不同节点／关系类型，但共享全部核心、适配器和界面。

## 没有夸大的部分

这里的“去中心化”是贡献者共同补全、数据可复制与迁移、部署不绑定单个平台。它目前不提供跨服务器共识、自动联邦同步或抗审查保证。

不可变整图快照足以验证第一版流程，但不等价于 QandA 的逐条内容修订引用。首版没有固定修订的边、删除／撤回、自动 Issue 归集或端到端审核界面。需要在采用该框架前按产品要求补齐；不应直接覆盖已有项目的治理数据。

服务器计算目前提供搜索、深度受限的邻域查询和连接统计，保留扩展位置。向量检索、复杂推理、推荐算法和独立图数据库需要具体规模和业务需求来证明价值。

## 下一步的合理顺序

先在一个真实社区验证投稿质量和维护工作量；随后完善修订、撤回和审核；再根据数据规模扩展索引。联邦同步和推理引擎应等到跨社区交换需求明确后再设计。
