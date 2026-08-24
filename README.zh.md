# dsh-calendar

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（dsh）的
**日历 / 日程集成**插件包（bundle）。遵循 dsh bundle 规范
（`"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`），以自包含 npm 包发布。

对接任意 **CalDAV** 服务器（Google Calendar、iCloud、Nextcloud、自建服务器），
自行完成 iCalendar / RRULE 的解析与计算，内置中文日历语境（农历、节假日、默认
`Asia/Shanghai` 时区），并提供时间冲突检测——**零运行时依赖**。

---

## 功能

1. **CalDAV 集成**：事件的 `list` / `create` / `update` / `delete` / `search`，
   基于标准 `REPORT / PROPFIND / GET / PUT / DELETE`，自动发现日历
   （well-known → current-user-principal → calendar-home-set → calendars）。
   双认证通道：
   - **Basic** 认证（Nextcloud、iCloud、通用服务器）
   - **Google OAuth2** 设备码流程（headless 友好）+ 刷新令牌自动续期、安全存储
   - 凭据来自环境变量 **或** dsh 凭据服务（`ctx.credentials`）**或** 本机
     chmod-0600 文件；**绝不写入日志**（`redact()` 会屏蔽所有已解析的密钥）。

2. **RRULE 展开与单实例编辑**：自研 RFC 5545 递归规则引擎，覆盖
   `FREQ`（SECONDLY…YEARLY）、`INTERVAL`、`COUNT`、`UNTIL`（UTC 与本地）、
   `BYDAY`（含序数）、`BYMONTH`、`BYMONTHDAY`、`BYYEARDAY`、`BYWEEKNO`、
   `BYSETPOS`、`WKST`、`BYHOUR/BYMINUTE/BYSECOND`，以及 `EXDATE`、`RDATE`。
   编辑或删除**单个实例**通过写入 `RECURRENCE-ID` override（删除即
   `STATUS:CANCELLED`）实现，绝不改动系列主事件。

3. **中文偏置**：农历换算（天文算法、完整覆盖 2000–2100）、中国节假日
   （春节/清明/端午/中秋/元宵/七夕/重阳/除夕/元旦/劳动节/国庆节）、以立春为
   界的干支与生肖、默认 `Asia/Shanghai` 时区；`cal_remind` 生成的提醒计划可
   直接喂给 dsh 的 session-local `schedule_create`。

4. **冲突检测**：按时段（含全天与递归实例）检测事件重叠，并返回重叠区间；
   更新时可排除自身。

5. **时区处理**：内嵌零依赖时区引擎（当代规则、2000–2100），正确处理夏令时；
   墙钟时间 ↔ UTC 换算（含歧义/缺失时间的确定性约定）；往返序列化保留 TZID。

6. **工具链**：`ctx.tools` 下的 dsh 工具（`cal_list`、`cal_get`、
   `cal_create`、`cal_update`、`cal_delete`、`cal_search`、`cal_conflicts`、
   `cal_holidays`，另加 `cal_calendars`、`cal_remind`），以及独立 CLI
   `dsh-calendar`。

---

## 目录结构

| 文件 | 作用 |
|---|---|
| `package.json` | npm 清单，含 `dsh.bundle.patch` 与 peer 依赖 |
| `cordis.patch.yml` | 配置层，挂载 bundle 入口 |
| `src/index.ts` | dsh 插件入口：`name` / `inject` / `Config` / `apply` |
| `src/service.ts` | 工具与 CLI 共用的高层操作 |
| `src/tools.ts` | `cal_*` 工具定义 |
| `src/credentials.ts` | 密钥解析 + 脱敏 |
| `src/dav/*` | CalDAV 客户端、OAuth2（Google 设备码）、XML、存储 |
| `src/core/*` | 时区、iCalendar、RRULE、递归、冲突、农历 |

零运行时依赖；`peerDependencies`（`@deepseek-ai/cordis`、
`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`）仅入口模块使用，由 dsh
运行时提供。

---

## 安装并接入 dsh

前提：已有一个可用的 dsh profile。

```bash
# 1. 构建 bundle（生成 lib/）
npm install
npm run build

# 2. 安装到你的 dsh profile
dsh plugin --profile <名字> add ./calendar
```

上述命令将该目录以 pnpm 链接进 profile 并追加到 `dsh.profile.bundles`，dsh
随后通过 `cordis.patch.yml`（`id: calendar, name: dsh-calendar`）挂载入口，
注册 `cal_*` 工具。

快速迭代也可直接打补丁层：

```bash
dsh --profile <名字> --patch ./cordis.patch.yml
```

（若是通过 git/包方式安装而非本地目录，请先 `npm run build`——清单发布的是
构建产物 `lib/`。）

### 配置

通过 bundle 的 `Config` 模式（在 patch / profile overlay 中）：

```yaml
- insert:
    - id: calendar
      name: dsh-calendar
      config:
        defaultTimezone: Asia/Shanghai
        serverUrl: https://nextcloud.example.com/remote.php/dav/
        # 或 calendarUrl: https://nextcloud.example.com/remote.php/dav/calendars/me/personal/
        authMode: basic   # basic | google
```

也可用环境变量 / dsh 凭据服务（见下）。

#### 凭据（绝不写日志）

| 密钥 | 含义 |
|---|---|
| `CALDAV_URL` | 完整日历集合 URL（Basic） |
| `CALDAV_USERNAME` / `CALDAV_PASSWORD` | Basic 凭据 |
| `GOOGLE_CLIENT_ID` | Google OAuth 客户端 id |
| `GOOGLE_CALDAV_REFRESH_TOKEN` | 长效刷新令牌（见下） |

可写入环境变量、dsh 凭据服务（`credentialRef` 名称与上表一致，如
`credentialRef('CALDAV_PASSWORD')`），或 CLI 的本机
`.calendar-credentials.json`（0600）。解析优先级：环境变量 → dsh 凭据服务 →
本机存储。

#### Google OAuth（设备码流程）

```bash
dsh-calendar auth google --device --client-id <CLIENT_ID>
```

会打开 URL 完成授权；刷新令牌保存到安全存储。服务端在令牌临近过期时自动刷新。

---

## 工具（`ctx.tools`）

| 工具 | 说明 |
|---|---|
| `cal_list` | 窗口内事件（含墙钟/UTC 时间） |
| `cal_get` | 单个系列及其具体出现 |
| `cal_create` | 创建（支持 RRULE/EXDATE/RDATE/全天）+ 冲突检查 |
| `cal_update` | 更新整个系列，或通过 `recurrenceId` 更新单个实例 |
| `cal_delete` | 删除系列，或仅删除单个实例（写入 CANCELLED override） |
| `cal_search` | 标题/描述/地点文本搜索 |
| `cal_conflicts` | 检查拟定时段（含递归）的重叠 |
| `cal_holidays` | 近期中国节假日 + 今日干支/生肖 |
| `cal_calendars` | 列出可访问的日历 |
| `cal_remind` | 提醒计划，按 dsh `schedule_create` 格式输出 |

**提醒联动**：dsh 的 schedule 表面刻意只面向模型（`schedule_create` /
`schedule_list` / `schedule_delete`）。`cal_remind` 展开事件后按实例返回
`{ at: { date, time, time_zone }, prompt }`——直接传给 `schedule_create`
即可按日历时区注册 session 本地提醒。

---

## CLI

```
dsh-calendar list  [--start "2026-01-01" --end "2026-01-31" --tz Asia/Shanghai]
dsh-calendar get      <uid>
dsh-calendar create   --summary "团队周会" --start "2026-03-02 10:00" --end "2026-03-02 11:00" \
                      --rrule "FREQ=WEEKLY;COUNT=4"
dsh-calendar update   <uid> --summary "改名" --recurrence-id "2026-03-09 10:00" --start "2026-03-09 15:00"
dsh-calendar delete   <uid> [--recurrence-id "2026-03-09 10:00"]
dsh-calendar search   "meeting"
dsh-calendar conflicts --start "2026-06-01 14:00" --end "2026-06-01 15:00"
dsh-calendar holidays --days 60
dsh-calendar calendars
dsh-calendar remind   <uid> --before 30m
dsh-calendar auth google --device
dsh-calendar auth status
```

若工作目录存在 `.env`，会先加载后再解析凭据。

---

## 时区模型

引擎内嵌常用时区的当代规则（上海、东京、首尔、伦敦、巴黎、柏林、纽约、芝加哥、
洛杉矶、悉尼、奥克兰等）。换算约定：

- `墙钟（TZID）↔ UTC`，夏令时确定性处理：
  - **重叠**（秋季，同一墙钟出现两次）取**第一次**出现（较大偏移）；
  - **缺口**（春季，墙钟不存在）按时钟**前移**越过缺口。
- 全天日期按日期存储，在事件/默认时区的午夜解释。
- RRULE 实例在 DTSTART 的墙钟表示上展开，因此 09:00 的每周会议在夏令时切换
  前后始终保持在 09:00。

## 农历

采用天文算法（Meeus 截断新月级数与太阳黄经级数）而非查表，因此**2000–2100**
全程由算法覆盖，含闰月（含著名的 2033 闰十一月）。测试用例钉住了 2000–2100
的春节日期、已知闰月（2001–2031）以及节假日日期（端午/中秋/清明）。

---

## 开发

```bash
npm install
npm test             # vitest：167 个用例（RRULE 向量、DST、农历、冲突、CalDAV mock）
npm run typecheck
npm run build        # 编译到 lib/
```

测试使用进程内 mock CalDAV 服务器（`test/helpers/mockCaldav.ts`）与 RFC 5545
示例向量，无需联网。

---

## 许可证

MIT —— 见 [LICENSE](./LICENSE)。
