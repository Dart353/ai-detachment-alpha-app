# Changelog

## [1.2.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.1.0...v1.2.0) (2026-09-21)


### Features

* **remote:** let the phone add panes and open folders ([cbad6ca](https://github.com/Dart353/ai-detachment-alpha-app/commit/cbad6cae4cc12d81570351ef9fdb9ba65f0ea751))
* **remote:** open a pane from the phone and type into it ([855c809](https://github.com/Dart353/ai-detachment-alpha-app/commit/855c809003113aa09dbee0da4817df3395eb973c))
* **remote:** publish pane statuses to a relay for the phone ([e7b7e97](https://github.com/Dart353/ai-detachment-alpha-app/commit/e7b7e972467718cb63596d0ada2ea3926142dad2))


### Bug Fixes

* **remote:** send a User-Agent on the relay connection ([6c6448c](https://github.com/Dart353/ai-detachment-alpha-app/commit/6c6448c3c5f4e1549b0e099a7355c1f5c9fe30ae))

## [1.1.0](https://github.com/Dart353/ai-detachment-alpha/compare/v1.0.0...v1.1.0) (2026-09-18)


### Features

* **pane:** show a pane's colour on its border and header ([22cc6ae](https://github.com/Dart353/ai-detachment-alpha/commit/22cc6aee2c389d7df547998db741de07a90b7d7b))


### Bug Fixes

* **sidebar:** unfold a workspace when one of its panes is focused ([5bb4dfd](https://github.com/Dart353/ai-detachment-alpha/commit/5bb4dfd16a7a79d908c8a7099370b4db7972d7d9))
* **terminal:** keep right-click out of the TUI so it no longer pastes ([7979996](https://github.com/Dart353/ai-detachment-alpha/commit/797999681c5fd832dfa9dcfe84a0243cb267f71e))
* **terminal:** re-measure the cell once the webfont loads ([da153ef](https://github.com/Dart353/ai-detachment-alpha/commit/da153ef124804f1b7c81b06c3bd713fecd2a1d24))

## 1.0.0 (2026-09-18)


### Features

* initial AI Detachment Alpha — minimal Claude Code terminal multiplexer ([8c9e9b1](https://github.com/Dart353/ai-detachment-alpha/commit/8c9e9b188ca2cd90c68f329868de32aadc6215f4))
* **sidebar:** make workspaces collapsible from the row ([b321403](https://github.com/Dart353/ai-detachment-alpha/commit/b3214033f8ad336170c041f785d8aca7a69ae599))
* **workspaces:** add workspace screen with layout and pane choices ([9123936](https://github.com/Dart353/ai-detachment-alpha/commit/912393633b0fce6b7c2df4bc22c4c89890d8a04e))
* **zone-editor:** delete occupied zones and cancel edits ([85357a7](https://github.com/Dart353/ai-detachment-alpha/commit/85357a78e7b00f0f0a35c5c791b1676edc8aeafd))


### Bug Fixes

* **layout-picker:** close after a tile is picked ([6b01e59](https://github.com/Dart353/ai-detachment-alpha/commit/6b01e59e82970bc986b08e3c135e5f5b5bbb4e36))
* **terminal:** put rows at fontSize × 1.6 instead of 25px ([e1b8060](https://github.com/Dart353/ai-detachment-alpha/commit/e1b8060d4780ff2604c9c14074661e1127ae1bc7))
* **titlebar:** let the empty bar drag the window again ([0bc517a](https://github.com/Dart353/ai-detachment-alpha/commit/0bc517a568dd5881e783d348a5dab935c5dffa90))
* **usage:** warn once per window instead of on every poll ([83b37bc](https://github.com/Dart353/ai-detachment-alpha/commit/83b37bc4274b3991cad109705576a3d858611afb))
