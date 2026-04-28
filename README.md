# FRC Prescouting (Static Site)

一个不依赖第三方包/外网的本地静态网站，用于 prescout：
- 概览看板（队伍数、Top 队伍、指标范围）
- 总表格（搜索/排序）
- 单队详情 + 自动分析
- 赛队对比（2-4 支队）

## 快速开始

1) 打开网页
- 推荐用本地静态服务器打开，例如：`python3 -m http.server 8000`
- 浏览器访问 `http://localhost:8000`

2) 导入数据
- 打开页面的“导入”页：支持粘贴腾讯文档表格（TSV/CSV）或导入 CSV 文件
- 导入后会立刻更新（仅当前浏览器会话生效，不会写入磁盘）

3) 部署到 GitHub Pages（自动）
- 把整个项目 push 到 GitHub 仓库 `main` 分支
- 确认仓库启用 Actions（默认启用）
- 首次 push 后，工作流会自动部署到 Pages：
  - `Actions` 页签可查看 `Deploy static site to GitHub Pages` 任务
  - `Settings → Pages` 中 Source 应显示 `GitHub Actions`

## The Blue Alliance（可选）

队伍详情页支持查询 TBA 的赛事资格赛排名（Qualification Rank）。

两种用法：
- 直接在“导入”页输入 `TBA Read API Key`（仅保存在内存里）
- 或运行本地代理避免 CORS / 避免前端输入 Key：
  - 如果你有 Node：`TBA_KEY=... node ./tba-proxy.mjs`
  - 如果你没有 Node：`TBA_KEY=... python3 ./tba-proxy.py`
  - 然后在页面里填写代理地址 `http://localhost:8787`

## Supabase（可选）

网站可以从 Supabase 读取 TBA Key，也可以保存当前导入的队伍数据。默认表结构可直接运行 `supabase-schema.sql`。

```sql
create table if not exists app_settings (
  key text primary key,
  value text not null
);

create table if not exists prescout_datasets (
  name text primary key,
  cols jsonb not null default '[]'::jsonb,
  rows jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists prescout_teams (
  team_number text primary key,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table if not exists statbotics_event_matches (
  event_key text primary key,
  matches jsonb not null default '[]'::jsonb,
  updated_at timestamptz not null default now()
);
```

在“导入”页填写 Supabase Project URL、anon public key、表名 `app_settings`、Key 名 `tba_api_key`，然后可以把当前 TBA Key 和当前队伍数据存进去。队伍数据会按 `team_number` 逐队保存到 `prescout_teams`，新 CSV 里同队号会覆盖旧信息；网站启动时会自动读取这些队伍。
赛程页会优先调用 Statbotics 的比赛预测数据，并把每个 event 的 Statbotics match 数据缓存到 `statbotics_event_matches`。

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
