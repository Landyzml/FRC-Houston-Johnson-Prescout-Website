# FRC Prescouting (Static Site)

一个不依赖第三方包/外网的本地静态网站，用于 prescout：
- 概览看板（队伍数、Top 队伍、指标范围）
- 总表格（搜索/排序）
- 单队详情 + 自动分析
- 赛队对比（2-4 支队）

## 快速开始

1) 准备数据
- 在腾讯文档中把表格 **导出为 CSV**
- 把文件放到 `data/prescout.csv`（可参考 `data/prescout.sample.csv`）

2) 打开网页
- 推荐用本地静态服务器打开，例如：`python3 -m http.server 8000`
- 浏览器访问 `http://localhost:8000`

3) 部署到 GitHub
- 把整个项目 push 到 GitHub 仓库
- 在仓库 Settings → Pages 中选择部署分支（通常是 `main` / root）
- 之后更新 `data/prescout.csv` 并 push，即可更新网站数据

## 配置

编辑 `config.json`：
- `sourceUrl`: 腾讯文档源链接（仅展示；网站实际读取 CSV）
- `teamIdColumnCandidates`: 队号列名候选（支持中英文）
- `preferredMetricColumns`: 你想重点分析/对比的列名（留空则自动从数值列推断）
- `maxCompareTeams`: 对比最多队数

## 数据要求（建议）
- 第一行必须是表头
- 队号列建议是 `Team` 或 `队号`
- 数值列请保持为纯数字（不要带单位文本）
