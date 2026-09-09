# 验证记录

环境：Windows、Node 24.12.0、Docker Desktop Linux containers。时间：2026-09-09。

## Runtime 0.1.0

- 本轮在 Windows + Node 24.12.0 运行 `npm test`，77/77 通过，包含原有 24 项与新增 53 项。
- `npm run validate`、`npm run build`、`npm run package:core` 和 `npm run package:runtime` 通过。打包时将 npm cache 指向工作区内的临时目录；没有更改用户全局配置。
- 仓库外临时目录只复制业务数据、配置、UI、说明与部署声明，离线安装实际 tgz，确认没有工作区软链接或相邻源码依赖。通过已安装 CLI 构建、引导具名账户、启动、真实 TOTP 登录、发布、搜索和重启。
- 合成兼容升级 fixture 将安装包版本改为 0.1.1 后重新打包安装，验证数据、配置、自定义 UI 与公开指针保留。这是协议兼容性测试，不代表实际发布了 0.1.1。
- 事务失败、并发审核、幂等、错误引用、固定证据、公开历史直达、来源撤回、私有详情审计、上传期间撤销、AES-GCM 旧 AAD 迁移、同意撤回与到期清理均有回归测试。
- 恢复测试覆盖空库限制、指针/历史/外部 ID/审计保留、会话失效、显式当前撤回清单和恢复事务内清理到期密文；错误输入不会部分恢复。
- UI 构建测试拒绝残留静态图、未知文件、被编辑产物、路径重叠和符号链接；仅清理先前清单确认的旧生成文件。内置浏览器实测页面及“西浦”别名搜索，确认示例正文、来源链接和逾期复核警示正常显示。
- 本轮未运行新的 Docker 镜像验证（沙箱无法连接本机 Docker daemon）；实际服务验证使用 Node + SQLite 路线。没有部署真实指南、推送 GitHub、关闭 issue 或发布 registry。

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
