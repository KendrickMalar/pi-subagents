# 同一セッションreloadで復旧コードを反映する検証計画

> 作成・更新：2026-10-15。出所：Pi 1.1.0実装、導入済みpi-profile/pi-scaffold、元タブの読み取り確認。
> 目的：再起動せずに修正版を読み込み、元親のsession・Profile・工程受領を維持できるか実証します。
> 実行：親が直接実行。隔離実証後、本人が固定コピー・設定1行更新・元タブreload・recover診断までを追加承認。子の再開は含みません。

**Goal**：共通package切替＋reloadの可否を、実SDKと実Scaffold receiverで判定します。
**Architecture**：合成HOMEで旧／新common sourceを切り替え、同じAgentSessionをreloadします。CLI固定sourceは対照条件にします。実タブで試行錯誤しません。
**Tech**：既存Node、Pi SDK 1.1.0、pi-scaffold 0.5.1、固定修正commit `f1a605b864b7a972bcfdf1862b1f04882bd68a14`。
**Spec**：既存計画 `2026-10-15-nested-run-recovery.md` §5と、今回の本人承認。

## 目次
1. 決定・根拠
2. 制約・重点
3. 隔離実証
4. 判定・後工程
5. 残る空白

## 1．決定・根拠
| 論点 | 決定／確認 | 理由 |
|---|---|---|
| 第一候補 | **元プロセスのreload** | 再起動・別sessionへの所有権移転を避ける |
| source | **subagentsは共通設定側** | 元launcherのProfile resourceRootsはpi-ghとpi-scaffoldのみ。旧subagentsは含まれない |
| 設定原本 | **dotfilesのsettings.json** | agent-muu→agent→Code/dotfilesへのsymlink。aliasへのchezmoi source-pathはnot managed |
| SDK | **reloadでsettingsを再読込しflagを保持** | AgentSession.reloadとDefaultResourceLoader.reloadを確認 |
| Scaffold | **SDKで同一sessionの再受領を実証** | 実Profile bridge/factoryを含む4case成功。実タブの読戻しは別途必須 |
| 反映 | **別途承認を取得しrecoverまで実施** | 共通設定はlocal統合済み。元タブだけreload、他タブ・認証・旧copyは維持 |

## 2．Global Constraints・Review Focus
- 書込みはこのworktreeの計画書・`.task-artifacts/live-reload/`・本計画の`.superpowers/sdd/`だけ。既存証跡は保持。
- 依存追加・install・実認証・外部API・実Herdr操作なし。HOME/agentDir/TMP/Scaffold stateは合成し、モデル応答もローカル。
- 元タブ・旧run・packet/receipt・認証・policy・許可ファイル・dotfilesは変更しない。
- 実packet再投入、runtime.handoffの直接代入、原本JSONの編集で合格にしない。既存flagのSDK保存・復元を観測する。
- 重点：①CLI固定元の残留 ②reload後の質問ガード消失 ③session/Profile変化 ④receipt書換え ⑤旧extension／子の残留。
- 製品コードの追加修正が必要なら停止し、その範囲を別途示す。隔離実証の合格を実タブ反映成功と混同しない。

## 3．隔離実証

### Task 1: source切替と工程維持を実証
**Files**：新規 `.task-artifacts/live-reload/run.mjs`、生成fixture・log・result.json。本計画のledger。
**Interface**：CLIから実行し、各caseの判定・SDK版・source/flag/session/profile/receiptの前後値・exit codeをJSON保存。

- [x] 実SDKで「CLI固定old sourceはreload後も残る」を対照確認。単なるimport失敗は結果に数えない。
- [x] common old→new＋同じsession.reloadで、old不在・newのみ・toolの新schemaをassert。
- [x] 実pi-scaffold extensionをロード。合成Profileと正式writePacket APIを使い、receiver-ready／turn-startedを正規経路で作る。
- [x] SDKのExtensionRunner.setFlagValueで起動時flagを一度だけ設定。reload時に再設定しない。
- [x] session ID/file・Profile・flag不変、receipt hash不変、reload前後ともImplementationの質問ガードがblockを返すことをassert。
- [x] 別sessionの受領は拒否。実モデル／外部APIの呼出し、子spawn、実GitHub書込みは0。
- [x] `node ... run.mjs`の実出力を読み、全case pass・exit0のみ合格。失敗ログ・fixtureを残し原因を分類。

## 4．判定・反映手順

### Task 2: 判定・反映手順を確定
- [x] Task 1のsource選択・工程維持の両方を満たした場合だけ、restart不要の手順としてまとめる。
- [x] 満たさなければblocked。新タブ・restart・packet再投入へ自動で切り替えない。
- [x] 実環境での次の候補操作を、対象と影響を示して別承認にする：
  1. 新しい固定コピーを追加。旧コピー保持。必要なruntime依存導入は対象・固定lock・ignore-scripts条件を別承認。
  2. dotfiles専用worktreeでcommon sourceの1行だけ更新、local統合。pushなし。
  3. 元タブのidle・旧runの終端proof/leaseを再確認後、元タブだけreload。新規packet指定なし。
  4. 同じPID/session/Profile/工程・新sourceのみを読み戻す。不一致なら停止。
  5. 元親でrecoverだけ実行し診断を回収。manager／coderのresumeは結果確認後の別段階。
- [x] 切戻しは設定参照の復元＋reloadを候補にし、raw proof/statusを過去へ書き戻さない。

## 5．判定・次のアクション・残る空白
| 項目 | 現在 |
|---|---|
| 修正コード | f1a605b8、全検査・独立再確認済み |
| reloadの組合せ実証 | Pi 1.1.0、4/4 pass・exit0。probe-8.log / result.json / receiptのhash一致 |
| 共有反映・元run復旧 | f1a605b8反映、元親のrecover=recovered。5件が診断時resumable:true。子再開は未承認・未実施 |

- [x] Task 1→Task 2を親が実行。製品コード変更・追加reviewerなし。反映案を非追跡reflection-proposal.mdへ保存（実施承認ではない）。
- リスク：reloadは元タブの全extensionを再初期化する。旧子が生存／所有不明なら実環境で実施しない。
- 残る空白：manager／子の実際のresumeとworktree排他の再確認、製品検証。今回のrecover成功やlease freeを、将来の再開成功・製品合格と同一視しない。
- 未解決のユーザー判断：子の実作業再開は別範囲。現在は元親を待機状態のまま維持。

### 出典・決定ログ
- Pi 1.1.0：dist/core/agent-session.jsのreload、resource-loader.jsのreload。
- 導入済みScaffold aa23804c：extensions/index.ts、handoff/receiver.js、core/agent-decision.js。
- 元タブは読み取り時点でidle。起動Profile contextのowner PIDを照合し、resourceRootsだけを抽出。nonceや本文は保存しない。
- 2026-10-15：本人が計画モード解除、手順書保存、親による隔離実証のみを承認。共有反映や元タブ操作への承認ではない。
- 隔離試験：初回のfixture内flag衝突、receipt名の誤り、SDK bindings不足を修正。製品のguardは変更せず、bindingsを持つ実SDK reloadでsession_start再発火を確認した。probe-8は4case成功、fetch/socket試行0、ローカル応答2回。
- 元manager・各子の保存proof/leaseを読み取り確認しただけで、回復成功や後の状態は推定していない。実環境への反映案は別途承認待ち。
- 追加承認：dotfiles設定用worktreeのみnpm install省略（package.jsonなし）、新固定copyのruntime依存導入、共通source参照1行のlocal統合、元タブreload、元親でrecoverまで。push・子再開なし。
- 実績：固定copy1001ファイルをf1a605b8と照合、runtime6 packages。dotfiles 5b04861をca37f1aでno-ff統合。元PiのPID/session不変、新guide/schemaを実応答で確認。空入力1回の非対話guard診断も本人が例外承認し、実tool_callがImplementation禁止理由を返した。
- 元親の正規recoverがrecovered、5件ともobserved/free/resumable:true。親も実tool-resultとauditを照合。原status/proof12ファイル・handoff3ファイル・保護対象11記録・旧copyコードのhash不変。処理後6 canonical sessionのleaseがfree。管理回復であり、子の再開・製品合格・Issue完了ではない。
- reload時のMCP警告（codemogger/circlebackの接続断、honeycombサインイン必要）は別件として未操作。元親は指示どおり待機。
