# OmegaUse-OfficeVal 8/0/8 加速实验切分

这是一份面向 B16 五 Mode 搜索的加速切分，不是完整 OmegaUse-OfficeVal 成绩。

- Feedback：8 题，覆盖 Word/PDF、PPT、Excel；Updater 可以读取详细反馈，Controller 也在这 8 题上决定晋升。
- Selection：0 题；本配置保持训练集内晋升协议。
- Final：8 道未参与进化的隐藏题，覆盖 Word、PPT、Excel，只在实验结束后评测最终 Candidate。
- 所有题均来自冻结的 Linux 可运行集合，且不要求 COM。

五种 Mode 必须共用同一个由这 8 道 Feedback 题生成的 H0 BaselinePack。旧 26/0/18 实验的 BaselinePack 因 Benchmark 身份不同不能直接导入。
