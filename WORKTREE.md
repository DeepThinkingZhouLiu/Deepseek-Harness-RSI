# Solver 失败反馈闭环隔离工作区

- Purpose: 修复 Solver 失败分类、失败经验反馈、Candidate 结算与内容摘要恢复校验。
- Branch: `fix/solver-failure-feedback`
- Status: active
- Base: `9678e3e4d2ae881890bbfbab9a5b3375db686e5e`
- Key result: 主进程复审补齐可信容器退出证据和反馈文件限长；新增平衡 8 Feedback / 0 Selection / 8 Sealed Final 加速切分与五 Mode B16 配置。
- Next step: 使用 8 道训练题重新生成公共 H0 Baseline Pack，再并发运行五种 Mode；旧 26/0/18 运行记录完整保留，但不跨 Benchmark 复用。
- Baseline: `npm install --ignore-scripts --package-lock=false`；固定 DSH 子模块初始化后 `npm test` 456 通过，0 失败。
