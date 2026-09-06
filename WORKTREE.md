# Solver 失败反馈闭环隔离工作区

- Purpose: 修复 Solver 失败分类、失败经验反馈、Candidate 结算与内容摘要恢复校验。
- Branch: `fix/solver-failure-feedback`
- Status: eval
- Base: `9678e3e4d2ae881890bbfbab9a5b3375db686e5e`
- Key result: 主进程复审补齐可信容器退出证据和反馈文件限长；新 single B2 真实运行已 CLOSED，单题 Reward 0 -> 0 -> 0.333333，版本边界见收尾记录。
- Next step: 用户审阅 docs/solver-failure-feedback-main-review.zh.md，决定是否合并并重启正式实验；旧 251 份逐题记录保留，不强行迁移旧 suite。
- Baseline: `npm install --ignore-scripts --package-lock=false`；固定 DSH 子模块初始化后 `npm test` 456 通过，0 失败。
