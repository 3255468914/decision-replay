# 推送到 GitHub —— 操作指南

> 适用状态：仓库已在本地完成（所有改动均已提交、52 个跟踪文件、工作区干净），但**还没有任何 remote**。
> 提交条数用 `git rev-list --count HEAD` 查即可 —— 本文一律不写死这个数字，因为任何一次提交都会让它过时。
> 本文按"照着做就能推上去"来写，每一步都给了验证方式。全程约 10 分钟。

---

## 0. 三分钟速览（TL;DR）

如果你只想最快推上去，按顺序执行这四步；细节都在后面。

```bash
# ① 先决定提交作者要不要改（见第 2 节）——这一步必须在推送之前完成

# ② 在 GitHub 网页上建一个空仓库（不要勾选任何初始化选项），拿到仓库地址

# ③ 关联并推送
cd decision-replay   # 换成你自己的克隆路径
git remote add origin https://github.com/3255468914/decision-replay.git
git push -u origin main
# 弹出浏览器 → 用 GitHub 账号登录授权（本机已装 Git Credential Manager 2.9.0，不需要手建 token）

# ④ 打开仓库页核对（见第 5 节的 6 项检查）
```

---

## 1. 会推上去什么（以及不会推什么）

**会推送 —— 52 个文件，`.git` 仅 2.2 MB，最大单文件 3.9 MB**：

| 路径 | 内容 | 大小 |
| --- | --- | --- |
| `src/`（含 `src/adapters/`） | 全部算法层与扶摇适配层，13 个文件 | 128 KB |
| `test/` | 5 个测试文件，71 个用例 | 48 KB |
| `scripts/` | 数据生成、拉取、CLI、冒烟、打包 | 68 KB |
| `public/` | 前端（无构建步骤的原生 ES Module） | 44 KB |
| `data/` | 构造数据集快照（1,979 点） | 436 KB |
| `data/real/` | **扶摇真实数据快照（2,749 点 / 24 序列），不含密钥** | 1.4 MB |
| `docs/` | 6 份文档 + 两套样例报告（各 3 份 Markdown） | 148 KB |
| `dist/standalone.html` | 免安装单文件版（内联两个数据源、各 15 份预计算报告） | 3.9 MB |
| 根目录 | `README.md`、`server.js`、`package.json`、`.gitignore`、`.gitattributes`、`.env.example` | 44 KB |

**不会推送**（`.gitignore` 已排除，且已实测确认）：

| 排除项 | 原因 |
| --- | --- |
| `.env` | **内含你的扶摇 API Key** —— 绝不入库 |
| `.tmp/` | 扶摇拉取缓存 |
| `out/` | `npm run analyze` 的导出产物，可随时重建 |
| `dist/assets/` | 打包中间产物（`reports-*.json`，5.8 MB），可随时重建 |
| `node_modules/`、`*.log`、`.vscode/`、`.DS_Store` | 通用噪音 |

> **`.env.example` 是要推的**，它只是模板：里面的 `FUYAO_API_KEY=` 是空值，其余都是默认值。
> 推送前可以先自己扫一遍确认没有密钥形态的串：
> ```bash
> git grep -I -n -E "sk-[A-Za-z0-9_-]{12,}" || echo "干净：没有密钥形态的串"
> ```

---

## 2. 推送前必须先定：提交作者是谁（✅ 已完成）

**这是本文唯一一件"做完就不好改"的事。**

~~当前全部提交的作者都是仓库级配置里的占位身份 `Candidate <candidate@example.com>`。~~

**2026-10-15 已处理完毕**：全部提交已通过 `filter-branch` 重写为
`3255468914 <3255468914@qq.com>`，仓库级 `user.name` / `user.email` 同步更新。
核对命令（应只显示这一个身份）：

```bash
git log --format="%h  %an <%ae>" | sort -u -k2
```

> 说明：提交用的是 QQ 邮箱 `3255468914@qq.com`。它能在 GitHub 上正确关联账号的前提是
> 该邮箱已添加到你的 GitHub 账号（`Settings → Emails` 里能看到它）。如果没添加，
> 贡献图会是灰的——但提交上仍显示此作者名，不影响评阅。
> 若你更希望不暴露真实邮箱，可以在 GitHub `Settings → Emails` 里拿到
> `<数字ID>+3255468914@users.noreply.github.com`，照下面的原始命令重写一遍即可（推送前都来得及）。

<details>
<summary>原始操作命令（已执行，留档备查）</summary>

```bash
cd decision-replay   # 换成你自己的克隆路径

# ① 更新仓库级配置
git config user.name "3255468914"
git config user.email "3255468914@qq.com"

# ② 重写全部提交的作者与提交者
git filter-branch --env-filter '
export GIT_AUTHOR_NAME="3255468914"
export GIT_AUTHOR_EMAIL="3255468914@qq.com"
export GIT_COMMITTER_NAME="3255468914"
export GIT_COMMITTER_EMAIL="3255468914@qq.com"
' --tag-name-filter cat -- --branches --tags

# ③ 核对
git log --format="%h  %an <%ae>" | sort -u
```

> `git filter-branch` 会打印一段"该命令已被弃用"的提示，**可以忽略**——它推荐替代品 `git filter-repo` 需要额外安装，
> 十几二十个提交的规模，`filter-branch` 是秒级完成，没必要多装一个工具。
</details>

> **如果已经推上去了才发现要改**：本地照上面重写后，需要 `git push --force-with-lease origin main`。
> 所以更好的做法是**推送前就定**。另外，`--force-with-lease` 比 `--force` 安全：如果远端有你不知道的新提交，它会拒绝而不是覆盖。

---

## 3. 第一步：在 GitHub 上建一个空仓库

1. 打开 <https://github.com/new>
2. **Repository name** 填 `decision-replay`（与本地目录同名，最省心）
3. **Description**（可选，建议填，评卷人一眼能看到这是什么）：
   ```
   投资决策复盘与学习：时点对齐 · 事后信息隔离 · 结构化归因 · 学习沉淀（零运行时依赖，71 个用例）
   ```
4. **可见性**：选 **Public**（题目要求"可访问的 URL + 源码仓库"，评卷人需要能直接打开）
5. **下面三个初始化选项全部不要勾**：
   - ❌ Add a README file —— 本地已有 `README.md`，勾了会产生冲突
   - ❌ Add .gitignore —— 本地已有，且是定制的
   - ❌ Choose a license —— 见下方说明
6. 点 **Create repository**

创建完你会看到一页"quick setup"提示。**忽略它给出的那些命令**（它建议 `git init` / `git add` / `git commit`，你本地全都做完了），只需要记下仓库地址：

```
https://github.com/3255468914/decision-replay.git
```

> **关于 License**：如果是笔试交付物、暂时不希望别人随意使用，**不选 license 就是"保留所有权利"**，这是默认状态，无需额外操作。
> 若之后想开源，再单独添加 `LICENSE` 文件即可（`Add file → Create new file`，文件名填 `LICENSE`，GitHub 会提示选择模板）。

---

## 4. 第二步：推送

```bash
cd decision-replay   # 换成你自己的克隆路径

# 关联远端（把 3255468914 换成实际值）
git remote add origin https://github.com/3255468914/decision-replay.git

# 确认关联正确
git remote -v

# 首次推送，并把本地 main 设为上游分支
git push -u origin main
```

### 会弹出登录

本机已安装 **Git Credential Manager 2.9.0**（`credential.helper=manager`），所以推送时会弹出一个窗口，选 **"Sign in with your browser"** → 浏览器里用 GitHub 账号授权即可。**不需要手工创建 Personal Access Token。**

如果窗口没弹出来、或提示要用户名密码，用这个保底方案：

1. 打开 <https://github.com/settings/tokens> → **Tokens (classic)** → **Generate new token (classic)**
2. Note 随便填（如 `decision-replay push`），Expiration 选 30 天
3. **勾选 `repo` 这一个 scope 就够了**
4. 生成后复制那串 `ghp_...`（**页面刷新后就再也看不到**）
5. 回到终端，**Username** 填你的 GitHub 用户名，**Password** 粘贴这串 token（不是你的账号密码）

> GitHub 从 2021 年起就不再接受账号密码推送了，所以粘贴 token 是正常的，不是出错了。

### 推送成功的输出长这样

```
Enumerating objects: 78, done.
Counting objects: 100% (78/78), done.
Delta compression using up to 8 threads
Compressing objects: 100% (52/52), done.
Writing objects: 100% (78/78), 1.86 MiB | 3.20 MiB/s, done.
Total 78 (delta 24), reused 0 (delta 0), pack-reused 0
To https://github.com/3255468914/decision-replay.git
 * [new branch]      main -> main
branch 'main' set up to track 'origin/main'.
```

看到 `* [new branch] main -> main` 就是成功了。

> 上面那段输出里的 object 数量（`78`、`1.86 MiB`）是**示意**，实际会随提交内容变化，不必对号入座；
> 真正要看的是最后两行：`* [new branch] main -> main` 与 `branch 'main' set up to track 'origin/main'`。

---

## 5. 第三步：推送后核对（6 项）

打开 `https://github.com/3255468914/decision-replay`，逐项对：

| # | 检查项 | 预期 |
| --- | --- | --- |
| 1 | 首页是否渲染出 README | 标题「投资决策复盘与学习 · Decision Replay」，顶部有在线体验链接，中文排版正常 |
| 2 | 提交数 | 点 `commits` → 条数应与本地 `git rev-list --count HEAD` 的输出**完全一致**（若第 2 节改了作者，作者名应是你的） |
| 3 | **`.env` 不存在** | 根目录文件列表里**没有** `.env`，只有 `.env.example` |
| 4 | `data/real/` 在、且不含密钥 | 点进 `data/real/` → 有 4 个 json；随便点开一个 `Ctrl+F` 搜 `sk-` → **搜不到** |
| 5 | 语言统计 | 右侧显示 JavaScript 为主，`dist/standalone.html` 不应被算进去（`.gitattributes` 标了 `linguist-generated`） |
| 6 | 单文件版能下载 | 点进 `dist/standalone.html` → 右上 `Download raw file` → 下载后双击，页面应能交互 |

**最该认真核的是第 3、4 项**——它们是"密钥没有泄漏"的唯一直接证据。

---

## 6. 演示视频怎么放（✅ 已完成）

视频**不建议直接提交进仓库**：90 秒的录屏通常几十到几百 MB，会让仓库体积膨胀且无法回退（Git 会永久保留历史）。三个可选方案：

| 方案 | 做法 | 优点 | 适合 |
| --- | --- | --- | --- |
| **A. GitHub Release 附件（推荐）** | 仓库页右侧 `Releases` → `Create a new release` → Tag 填 `v1.0` → 把视频文件拖进附件区 | 和代码在同一个地方，评卷人一次就能拿全；不污染 git 历史 | **笔试交付首选** |
| **B. 传到视频平台** | 上传 B 站 / YouTube（可设为"仅链接可见"），把链接写进 README | 播放方便、不占仓库 | 需要流畅播放时 |
| **C. 放进仓库** | 直接 `git add` 视频 | 一处全有 | ⚠️ 不推荐，除非视频 < 20 MB |

**实际采用：方案 A**。已上传到 Release `v1.0`，实测可下载：

- 附件地址：<https://github.com/3255468914/decision-replay/releases/download/v1.0/default.mp4>
- 大小 87.3 MB，HTTP 200 可下载
- ⚠️ 注意附件名被上传流程改成了 `default.mp4`（不是 `演示视频.mp4`）。若希望文件名更清晰，
  可在 Release 页删除该附件后重新上传并命名 `demo-90s.mp4`，然后同步修改 README 里的链接。
- 本地 `演示视频.mp4` 为 88 MB，已加入 `.gitignore`（`*.mp4`），**确认不在 git 历史中**。

**推荐组合**：用 **方案 A** 传原文件（保证画质与可下载），同时在 README 里放一句说明。README 里建议加这样一节（`docs/DEMO_SCRIPT.md` 是配套的脚本与分镜）：

```markdown
## 演示视频（90 秒）

- 直接下载：<https://github.com/3255468914/decision-replay/releases/download/v1.0/default.mp4>
- 脚本与分镜：见 [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md)
```

> 如果视频文件不在项目目录里，Release 上传时用"拖拽文件"即可，不需要先复制进仓库。

---

## 7. 出错了怎么办

### 7.1 最坏情况：不小心把 `.env` 提交了

**先不要 push**。按下面顺序处理（顺序很重要，"先删文件再提交"是不够的，因为历史里还留着）：

```bash
# ① 从索引中移除（保留本地文件，不删你的 .env）
git rm --cached .env

# ② 确认 .gitignore 里已有 .env（本项目已有）
git check-ignore -v .env

# ③ 提交这个移除动作
git commit -m "chore: 移除误入索引的 .env"

# ④ 如果这个文件出现在更早的历史提交里，用 filter-branch 从全部历史中抹掉
git filter-branch --force --index-filter \
  'git rm --cached --ignore-unmatch .env' \
  --prune-empty -- --all
```

**如果已经 push 了**：除了上面四步，还必须 `git push --force-with-lease origin main`，然后**立即去扶摇后台把这个 API Key 作废并重新生成**——只要它出现在过公开仓库里，就要当作已泄漏处理。历史虽然改写了，但已被抓取/缓存过的内容无法保证消失。

### 7.2 `error: remote origin already exists`

说明之前加过 remote，改成更新地址即可：

```bash
git remote set-url origin https://github.com/3255468914/decision-replay.git
```

### 7.3 `error: failed to push some refs` / `Updates were rejected`

通常是因为建仓库时勾了 README 或 .gitignore，导致远端有一个你本地没有的提交。两种解法：

```bash
# 解法一（推荐）：把远端那个初始化提交拉下来合并
git pull --rebase origin main
git push -u origin main

# 解法二：确定远端那个提交没有价值，直接覆盖
git push --force-with-lease origin main
```

### 7.4 警告 `LF will be replaced by CRLF`

Windows 上的正常提示，**可以忽略**。本项目已用 `.gitattributes` 把入库换行统一为 LF，跨平台协作不会产生整文件 diff。

### 7.5 推送卡住 / 很慢

`dist/standalone.html` 有 3.9 MB，首次推送 1.8 MiB 左右的包体，正常几秒到几十秒。若长时间无进展，多半是网络问题，可重试；也可以临时切到 SSH（需要先配 SSH key，本机目前没有 `~/.ssh`）。

---

## 8. 附：完整命令清单（可整段复制）

```bash
# ── 第 2 节：作者信息（可选，只在需要改时执行）────────────────
cd decision-replay   # 换成你自己的克隆路径
git config --unset user.name
git config --unset user.email
git filter-branch --env-filter '
export GIT_AUTHOR_NAME="你的名字"
export GIT_AUTHOR_EMAIL="你的邮箱"
export GIT_COMMITTER_NAME="你的名字"
export GIT_COMMITTER_EMAIL="你的邮箱"
' --tag-name-filter cat -- --branches --tags
git log --format="%h  %an <%ae>" | sort -u

# ── 推送前自检 ────────────────────────────────────────────────
git status --short                                  # 应为空
git grep -I -n -E "sk-[A-Za-z0-9_-]{12,}" || echo "干净：没有密钥形态的串"
git ls-files | wc -l                                # 应为 52
du -sh .git                                         # 应为 2.2M 左右

# ── 关联并推送 ────────────────────────────────────────────────
git remote add origin https://github.com/3255468914/decision-replay.git
git remote -v
git push -u origin main

# ── 推送后核对 ────────────────────────────────────────────────
git rev-list --count HEAD                           # 记下这个数，与 GitHub 上的提交条数对照
git ls-remote --heads origin                        # 应能看到 refs/heads/main
```
