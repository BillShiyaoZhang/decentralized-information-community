# 验证记录

环境：Windows、Node 24.12.0、Docker Desktop Linux containers。时间：2026-09-09。

## 0.2.0

- 主仓库 `npm test`：24/24 通过；Linux 开发容器中同样 24/24 通过。
- `npm run validate` 和 `npm run build` 通过，默认社区保留校园演示的 8 个节点、8 条关系。
- Node 22.13.0 Alpine 只读挂载仓库运行核心与适配器测试，15/15 通过。
- 独立包只含入口、类型、README、LICENSE 和包清单共五个文件；测试把真实 tgz 安装到仓库外临时项目，验证包名导入、提案/冲突与严格 NodeNext / Bundler 类型解析。
- 自定义社区从 revision 7 静态快照初始化 SQLite，第二次初始化拒绝覆盖；接受修改后导出，再构建静态镜像，ID、版本、蓝图、节点与关系完全一致。
- 静态产物的仓库子路径测试通过。GitHub 工作流已编写，未推送、启用远程模板设置或实际执行 Pages 发布。
- Docker 开发预览正常；服务器镜像构建成功，容器显示 healthy。动态配置为 server 模式，`/api/graph` 与 `/data/graph.json` 返回相同当前数据库快照。
- `xjtlu-unofficial-guide/apps/web` 从 vendored tgz 干净 `npm ci` 成功，保留原有依赖版本。类型检查、lint、67 项测试和生产构建通过。
- 校园真实页面 `/answers/where-to-check-e-bridge` 返回 200，渲染“同主题其他答案”、Learning Mall 链接和主题链接；没有候选的 `/answers/current-student-service-entry` 返回 200 且不渲染空导航区域。
- 本轮以本地 HTTP 响应核验页面，并在内置浏览器展示了含关联卡片的真实校园页面；未做完整浏览器点击或视觉回归。没有上传 Sites，也未发布 npm registry。

## 首版已验证并保留的能力

Windows / Docker 共享目录轮询更新、API 带令牌写入、无令牌拒绝、旧 revision 冲突、SQLite 重开一致性、CLI 并发锁、静态草稿恢复和迁移均由现有测试覆盖。首版的浏览器 WebMCP 搜索和节点定位检查通过。

这份记录说明上述流程可运行，不是性能基准或生产安全审计。权限与协议边界见 README 和架构文档。
