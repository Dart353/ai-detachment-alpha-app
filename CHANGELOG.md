# Changelog

## [1.7.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.6.0...v1.7.0) (2026-09-24)


### Features

* **explorer:** start an agent or a terminal in a folder of the workspace ([8fc9958](https://github.com/Dart353/ai-detachment-alpha-app/commit/8fc99588b897b6c8e3c101bc2cad0d6149926004))
* **sidebar:** switching to a workspace unfolds its panes ([ac3f8ab](https://github.com/Dart353/ai-detachment-alpha-app/commit/ac3f8ab430ec9abdb086546297948ab5e444ae98))

## [1.6.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.5.0...v1.6.0) (2026-09-24)


### Features

* **remote:** pictures from the phone, and agents with a model and effort ([88b18b4](https://github.com/Dart353/ai-detachment-alpha-app/commit/88b18b43bbae75292c8baa5632010bf1b706c0d2))


### Bug Fixes

* **explorer:** reveal a WSL path in the host's file manager ([00141cf](https://github.com/Dart353/ai-detachment-alpha-app/commit/00141cfefd80c63674d0310292a82c687bebbfcd))

## [1.5.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.4.0...v1.5.0) (2026-09-24)


### Features

* **explorer:** open a file in a new Claude Code pane ([81c35c1](https://github.com/Dart353/ai-detachment-alpha-app/commit/81c35c1c9296cd2f3ca64b346bbd423d572bac0c))
* **sidebar:** drag to reorder panes within a workspace ([6c55207](https://github.com/Dart353/ai-detachment-alpha-app/commit/6c55207cbe7cdac87d1a3af0de79e65bae8e270b))

## [1.4.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.3.0...v1.4.0) (2026-09-22)


### Features

* **grid:** shift-drag a pane to span it over a neighbouring zone ([04366e5](https://github.com/Dart353/ai-detachment-alpha-app/commit/04366e565b5bd5864caa70e2b92600090fbe9a56))
* **grid:** sixteen pane colours in two strengths ([4c7c645](https://github.com/Dart353/ai-detachment-alpha-app/commit/4c7c645bd8b6a1591b363026be592edd3a533f25))
* **sidebar:** coloured pane rows wear a translucent wash of their colour ([635e4f1](https://github.com/Dart353/ai-detachment-alpha-app/commit/635e4f1b22688b12abea96e658944922ad0516b9))


### Bug Fixes

* **grid:** stop two panes trading focus every frame ([b7f1a58](https://github.com/Dart353/ai-detachment-alpha-app/commit/b7f1a58770e2a7d9eb7ea41ed773177dd849f5ba))

## [1.3.0](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.2.1...v1.3.0) (2026-09-22)


### Features

* **remote:** list the phones connected to this machine, and disconnect one ([4d9999c](https://github.com/Dart353/ai-detachment-alpha-app/commit/4d9999cae7589f9e38283ea49a997d671cbf5f22))

## [1.2.1](https://github.com/Dart353/ai-detachment-alpha-app/compare/v1.2.0...v1.2.1) (2026-09-22)


### Bug Fixes

* **terminal:** keep the last row inside the pane ([6487518](https://github.com/Dart353/ai-detachment-alpha-app/commit/64875187831daec511dff35dd6a50597aac38801))

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
