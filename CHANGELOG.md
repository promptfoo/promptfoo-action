# Changelog

## [1.2.0](https://github.com/promptfoo/promptfoo-action/compare/promptfoo-action-v1.1.0...promptfoo-action-v1.2.0) (2025-11-23)

### Features

* add --no-table and --no-progress-bar flags ([#583](https://github.com/promptfoo/promptfoo-action/issues/583)) ([5b9ed14](https://github.com/promptfoo/promptfoo-action/commit/5b9ed14fe5e6d1da23a05f39b669b1b6b11b4436))
* add `working-directory` as an input ([#359](https://github.com/promptfoo/promptfoo-action/issues/359)) ([481aac1](https://github.com/promptfoo/promptfoo-action/commit/481aac15e3cf6ab0af54eac2a05adc2ba8386e38))
* Add comprehensive caching support for GitHub Actions ([#625](https://github.com/promptfoo/promptfoo-action/issues/625)) ([438d8e3](https://github.com/promptfoo/promptfoo-action/commit/438d8e33a8b3e7cde53b3e0c763d582743e46b12))
* Add custom provider dependency detection with wildcard support ([#615](https://github.com/promptfoo/promptfoo-action/issues/615)) ([425c078](https://github.com/promptfoo/promptfoo-action/commit/425c078a987b7f4a611ceca200ab7fa2d61235fa))
* add max-concurrency option for rate limiting ([#591](https://github.com/promptfoo/promptfoo-action/issues/591)) ([6d0934e](https://github.com/promptfoo/promptfoo-action/commit/6d0934ea6a490d21d7ed3daf19b4dd1d23d3e445))
* add no-cache parameter to promptfoo-action ([#669](https://github.com/promptfoo/promptfoo-action/issues/669)) ([93f18ad](https://github.com/promptfoo/promptfoo-action/commit/93f18ada2902d795c8ad9c0a9b5161bd17e934e4))
* add option to disable comment ([#584](https://github.com/promptfoo/promptfoo-action/issues/584)) ([d660275](https://github.com/promptfoo/promptfoo-action/commit/d660275d722e32a094b01c8f867faa2d5c1efd8c))
* add support for loading .env files ([#579](https://github.com/promptfoo/promptfoo-action/issues/579)) ([68bfbb7](https://github.com/promptfoo/promptfoo-action/commit/68bfbb7f7c381f63e76571da7c227d4ed943e13b))
* add workflow_dispatch support for manual triggering ([#585](https://github.com/promptfoo/promptfoo-action/issues/585)) ([30143f8](https://github.com/promptfoo/promptfoo-action/commit/30143f8efcbb643065462e79af106707e1f0fce4))
* make `prompts` parameter optional ([#108](https://github.com/promptfoo/promptfoo-action/issues/108)) ([cb2158d](https://github.com/promptfoo/promptfoo-action/commit/cb2158d29f7b2dcdbdcd448b9c84d91b19e27147))
* make prompts optional ([#414](https://github.com/promptfoo/promptfoo-action/issues/414)) ([7f9fc19](https://github.com/promptfoo/promptfoo-action/commit/7f9fc1945450cc37c479c0b1392c5593f5cee7e8))
* make prompts parameter truly optional ([#592](https://github.com/promptfoo/promptfoo-action/issues/592)) ([95bf94d](https://github.com/promptfoo/promptfoo-action/commit/95bf94db9ef165012947a19a595bb45b164f4062))
* Skip sharing when auth is not available ([#614](https://github.com/promptfoo/promptfoo-action/issues/614)) ([71ad945](https://github.com/promptfoo/promptfoo-action/commit/71ad9452ff0d64a76a8e245ce44a6b4b21647030))
* validate Promptfoo API key before running evaluation ([#683](https://github.com/promptfoo/promptfoo-action/issues/683)) ([b6d2253](https://github.com/promptfoo/promptfoo-action/commit/b6d2253f9ed202775749bacf0efd66ae149017ae))


### Bug Fixes

* Add build step before package in dependabot workflow ([#679](https://github.com/promptfoo/promptfoo-action/issues/679)) ([6bc088d](https://github.com/promptfoo/promptfoo-action/commit/6bc088dfcee6c6b029f536974cb1c154c38a3a80))
* allow more git refs in `validateGitRef` ([#636](https://github.com/promptfoo/promptfoo-action/issues/636)) ([7c3955a](https://github.com/promptfoo/promptfoo-action/commit/7c3955aeef37a125ed9a77ee9e9e015dc6ed0cca))
* checkout repo to load script file in github-script action ([#687](https://github.com/promptfoo/promptfoo-action/issues/687)) ([de3682f](https://github.com/promptfoo/promptfoo-action/commit/de3682f3182ba8c50dee70ffe0402f6807700482))
* **ci:** rebuild dist files properly in dependabot PRs ([#722](https://github.com/promptfoo/promptfoo-action/issues/722)) ([41e299b](https://github.com/promptfoo/promptfoo-action/commit/41e299b13fad1f2084f5644c1feed62f280094d2))
* **deps:** update dependency glob to v13 ([#750](https://github.com/promptfoo/promptfoo-action/issues/750)) ([f4f1022](https://github.com/promptfoo/promptfoo-action/commit/f4f102249c32faf369678dc3ecb1a6fe0dba41e4))
* **dist:** rebuild after dependency updates ([#721](https://github.com/promptfoo/promptfoo-action/issues/721)) ([02fb87e](https://github.com/promptfoo/promptfoo-action/commit/02fb87e4573648be26edb00a9a393753039920ec))
* **dist:** rebuild distribution files after dependency update ([#720](https://github.com/promptfoo/promptfoo-action/issues/720)) ([2b9a209](https://github.com/promptfoo/promptfoo-action/commit/2b9a20955b4b209a00e7657bea8e1e09337ff7e8))
* Potential fix for code scanning alert no. 5: Workflow does not contain permissions ([#542](https://github.com/promptfoo/promptfoo-action/issues/542)) ([764baf4](https://github.com/promptfoo/promptfoo-action/commit/764baf4359ca58cf1157d6cb6da5e40d527ddf76))
* skip empty commits in dependabot workflow ([#682](https://github.com/promptfoo/promptfoo-action/issues/682)) ([0c501d5](https://github.com/promptfoo/promptfoo-action/commit/0c501d526432befe6c42b84c03e5950a7a874994))
* **workflows:** remove dependabot post-update automation workflow ([#403](https://github.com/promptfoo/promptfoo-action/issues/403)) ([05d17a4](https://github.com/promptfoo/promptfoo-action/commit/05d17a4a171fad88efbf071c9a1471c6cd3a8eb1))
* **workflows:** update permissions in GitHub Actions workflows ([#459](https://github.com/promptfoo/promptfoo-action/issues/459)) ([edc671c](https://github.com/promptfoo/promptfoo-action/commit/edc671cf6847537e8fc3d2ed200bb58a16a1de40))


### Miscellaneous Chores

* update Node.js runtime from node16 to node20 ([#588](https://github.com/promptfoo/promptfoo-action/issues/588)) ([37e3eff](https://github.com/promptfoo/promptfoo-action/commit/37e3effa6514c83a2d473b94edce0062a7b5a7cb))
