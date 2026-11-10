# 发布到 GitHub（跳过 git push，直接走 REST API）

本机到 `github.com` 的 443 连接不可用（`api.github.com` 直连也超时），但按 `github-access` 技能里的 IP 池，
用 `curl --resolve` 顶 IP 可以正常访问 `api.github.com`。这个脚本就靠它完成两件事：

1. 创建仓库（若不存在）；
2. 把工作区里所有纳入版本管理的文件用 Contents API 逐个上传。

不需要 `git push`，因此不受 `github.com:443` 不通的影响。

## 用法

```bash
# 需要的 token 权限：
#   经典 PAT  → 勾 repo
#   细粒度 PAT → Administration: Read and write（目标账号下）
export GITHUB_TOKEN=ghp_xxx

# 可选：仓库名、可见性
export DSH_MARKET_REPO=dsh-market
export DSH_MARKET_PRIVATE=true

node scripts/publish-github.mjs
```

脚本会打印每个文件的上传结果，最后给出仓库地址。

## 为什么不用 gh

`gh` 用自己那次 DNS 解析的结果，本机 hosts 与 `--resolve` 都改不动它（`gh` 官方行为），
所以 `gh api` / `gh repo create` 在这台机器上必然超时。curl 顶 IP 是唯一可行路径。
