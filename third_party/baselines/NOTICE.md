# Baseline source notice

The ACE baseline is adapted from [ace-agent/ace](https://github.com/ace-agent/ace),
licensed under Apache-2.0. The playbook update behavior follows `ace.py`,
`playbook_utils.py`, and `utils.py`.

The Evo-Bench Evolver baseline is adapted from
[RUCAIBox/Evo-Bench](https://github.com/RUCAIBox/Evo-Bench), licensed under
Apache-2.0. The workflow follows `evobench/evolution/harness.py` and
`evobench/evolution/prompts.py`.

The shared license text is preserved in `LICENSE.txt`.

Only the prompt semantics required by this integration are represented in
`baselines/prompts.json`; the upstream execution engines are not vendored.
