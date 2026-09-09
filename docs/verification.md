# 本次验证记录

验证环境：Windows 主机、Docker Desktop Linux containers、`node:24.12.0-alpine`。时间：2026-09-09。

- Docker 开发服务启动并返回 HTTP 200。
- Windows / Docker 共享目录使用轮询检测修改；编辑 CSS 后，已验证无需重启容器就能返回与源文件一致的新内容。
- `docker compose exec -T dev npm test`：18 项测试全部通过。
- 数据验证：校园示例 8 个节点、8 条关系；决策库示例使用不同类型且通过同一核心验证。
- 服务器镜像构建成功，非 root 容器启动成功，SQLite volume 初始化成功；`/api/health` 返回 200。
- API 测试验证了带令牌写入成功、无令牌拒绝、旧 revision 返回 409，以及持久化后重新打开数据库的数据一致性。
- CLI 测试验证了提案接受、冲突拒绝、并发锁，以及服务器快照导出后与静态图一致。
- 静态资源在 `/my-repository/` 子路径下加载成功，数据与模块使用相对 URL。
- Sites 标准构建脚本在 Linux 容器中通过。Windows 下该辅助脚本的 npm 启动器存在路径兼容性问题，项目自身的 `npm run build` 正常。
- 浏览器 WebMCP 的 `search_community`、`show_community_node` 完成有效和无效输入检查；无效请求不会破坏当前图。没有执行完整的跨浏览器点击回归或视觉截图验收。

这份记录说明首版流程可运行，不是性能基准或生产安全审计。默认服务器权限、静态草稿和协议边界见 README 与架构文档。
