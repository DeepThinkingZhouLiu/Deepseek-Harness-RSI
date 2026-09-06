# Solver 失败反馈闭环隔离工作区

- Purpose: 修复 Solver 失败分类、失败经验反馈、Candidate 结算与内容摘要恢复校验。
- Branch: `fix/solver-failure-feedback`
- Status: active
- Base: `9678e3e4d2ae881890bbfbab9a5b3375db686e5e`
- Key result: 不改动共享 H0、014 正式实验和冻结比较条件；实现可信诊断与可恢复反馈闭环。
- Next step: 相关测试、五 Mode fixture 集成验证及独立最小真实 smoke。
- Baseline: `npm install --ignore-scripts --package-lock=false`；固定 DSH 子模块初始化后 `npm test` 456 通过，0 失败。
