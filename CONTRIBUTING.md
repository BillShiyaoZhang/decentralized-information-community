# 贡献指南

欢迎补充核心能力、领域示例和接入文档。首先阅读 `docs/architecture.md`，避免把某个具体社区的规则写死到核心。

## 提交代码

1. 在自己的分支开发，先 `npm ci`，再 `npm run dev`。没有本机 Node 时可 `docker compose run --rm dev npm ci`，再 `docker compose up -d dev`。
2. 为数据安全、并发和协议变化补充必要测试；轻量样式修改不需要机械地增加测试。
3. 运行 `npm test`、`npm run validate`、`npm run build` 和 `npm run package:core`；也可在 dev 容器内运行。包测试会安装真实打包产物并验证类型。
4. 提交 PR，说明具体问题、行为变化和验证结果。不要提交令牌、数据库、用户草稿或 `.env`。

## 提交内容

页面中的贡献在静态模式下只会成为本机草稿。“数据与提案 → 导出投稿提案”后，通过社区仓库 PR 或维护者约定的渠道提交。

维护者需要审核正文、来源、适用范围和关联理由，然后按 `docs/deployment.md` 合并提案。校验成功只表示格式与图结构正确，不证明内容真实，也不授予发布权限。

保留稳定 ID。碰到 revision 冲突时，对照最新公开快照重新组织提案，不要只改版本数字来绕过检查。

用户社区的内容位于 `content/graph.json`，品牌与入口位于 `community.config.json`；`examples/` 保留为示例和测试夹具。核心包协议或 API 变化需同时更新 `packages/core/index.d.ts`、包版本与文档。
