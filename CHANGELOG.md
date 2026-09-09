# Changelog

## 0.2.0 — 2026-09-09

- 同仓库支持模板 → Pages 自动发布，以及同配置启动 Docker 服务器。
- 新增 `community.config.json` 与 `content/`，分离社区配置、用户内容和引擎源码。
- 新增拒绝覆盖已有数据库的初始化命令，并验证静态 → SQLite → 静态往返迁移。
- 独立分发 `@information-community/core`，包含 TypeScript 类型、包文档与 MIT 许可证；暂未发布 registry。
- 校验 JSON 扩展字段，忽略对象键顺序造成的虚假差异。
- 在真实校园指南答案详情页接入同主题答案导航。

## 0.1.0 — 2026-09-09

- 首个可运行版本：图契约、提案、静态草稿、HTTP / SQLite、领域示例和参考界面。
