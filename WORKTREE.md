# Solver 失败反馈闭环隔离工作区

- Purpose: 修复 Solver 失败分类、失败经验反馈、Candidate 结算与内容摘要恢复校验。
- Branch: `fix/solver-failure-feedback`
- Status: active
- Base: `9678e3e4d2ae881890bbfbab9a5b3375db686e5e`
- Key result: 最终回归 490/490；五 Mode fixture 完成；独立真实 single B2 已 CLOSED，无提分，版本边界见验证记录。
- Next step: 用户审阅本地补丁与 docs/solver-failure-feedback-validation.zh.md，决定是否合并；不自动恢复旧正式 suite。
- Baseline: `npm install --ignore-scripts --package-lock=false`；固定 DSH 子模块初始化后 `npm test` 456 通过，0 失败。
