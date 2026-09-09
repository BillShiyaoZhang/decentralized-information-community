# 真实接入：西浦非官方指南

核心包以 `.tgz` 安装进 `xjtlu-unofficial-guide/apps/web`，版本为 `@information-community/core@0.2.0`。使用方将打包产物放在 `vendor/`，由 `package.json` 与 lockfile 固定；不依赖本机相邻仓库路径、源码软链接或尚未发布的 npm 版本。

## 可见效果

打开校园指南的 `/answers/where-to-check-e-bridge`，答案下方显示“同主题其他答案”，其中包含 `/answers/learning-mall-help`。点击可进入完整答案，也可通过“浏览整个主题”回到 `accounts-and-systems`。没有候选时隐藏该区域，历史版本页不显示它。

## 接入边界

`apps/web/lib/public-knowledge.ts` 从 `listTopics()` 与 `searchAnswerCards({ topicSlug, limit: 4 })` 的结果投影：

```text
answer:<当前答案 ID> → topic:<主题 ID> ← answer:<另一答案 ID>
```

先由原业务仓储决定可公开内容，再调用 `validateGraph` 校验结构，使用 `neighborhood(current, 2)` 找出最多三张其他答案。投影只用于这次导航，revision 为 0，不是整个校园知识库或业务内容修订版本。

投影仅携带稳定 ID、标题与关系，不复制逐句正文、证据、私有资料、搜索事件或审核记录。原有 `AnswerCardPreview` 继续展示原 DTO 的来源覆盖、复核和争议提示；候选原有排序保持不变。可选导航出错只隐藏该区域。

该集成没有新建数据库表，没有开放投稿或改写既有登录、授权、审核与发布策略。它验证了一个独立应用可以直接消费核心包，同时保留自己的页面与数据治理。

## 升级与验证

1. 在本核心仓库运行测试并 `npm run package:core`。
2. 将新版本产物放进使用方 `apps/web/vendor/`，`npm install ./vendor/<新产物>.tgz`，提交产物、清单与 lockfile。
3. 运行使用方的类型检查、lint、测试和构建，检查关联页面。

集成新增四项测试，覆盖同主题两跳关系、原 DTO 保留、隐藏主题、无候选、排序、去重、三条上限与字段白名单。核心仓库另有外部临时项目的真实 tgz 安装测试，保证无需工作区链接即可使用。

主仓库的校园演示内容仍保留，尚未将其整体替换成外链。
