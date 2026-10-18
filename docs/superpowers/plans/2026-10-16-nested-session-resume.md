# 検証済み旧子sessionの限定resume 実装計画

> 作成：2026-10-15。出所：F001の実resume拒否、f1a605b8のvalidatorと保存記録。
> 目的：広い信頼根を追加せず、recoverで検証した当該runのsessionだけを正規resumeへ渡す。
> 実行：本人承認済み。親が直接実装・隔離検証、最後に独立確認1件。共有反映・F001再開は別承認。

**Goal**：Task別保存先の旧coderを、復活managerから実resumeできることを証明する。
**Architecture**：既存のprivate native回復契約へ、run単位の正確なcanonical session証拠を追加。通常のtrusted rootは変更しない。
**Tech**：固定依存、TypeScript、Node test、実Pi 1.1.0＋ローカルprovider。
**Spec**：既存nested-run-recovery計画の所属・終端・lease・非継承制約と、今回の限定承認。

## 1．事実・決定
| 論点 | 決定／確認 | 理由 |
|---|---|---|
| 現在 | Node runner54/54・exit0、その後の子resumeがoutside trusted roots | 製品全検査・Swift・統合は未完了 |
| 根 | defaultSessionDir／親session由来だけを使う | Task別の明示保存先が除外されている |
| sessionDir | 記録はasync-id、実fileは隣のrun-0 | 保存dirをそのまま信頼根へ足す案は不可 |
| 方針 | **検証済みrunの正確なfileだけ、private native契約で渡す** | 既存の親／子所属とcanonical排他を維持 |
| 不足時 | **blocked／resumable:false** | 証拠が足りない旧形式を推測で許可しない |

## 2．Global Constraints・Review Focus
- 専用worktreeを継続利用。稼働f1コピー・共有設定・KnoudeCode製品・旧runtime原本を変更しない。
- any禁止、依存追加なし。HOME/TMP/cache/logは本worktree内。実認証・外部API・実Herdrなし。
- 新しいmodel入力、defaultSessionDirの拡張、session移動、validator削除、metadata/lease手編集で迂回しない。
- 元親限定recover、route・parent・agent・budget・launch/session identity・proof・lease検査を維持。新grantは孫へ非継承。
- 重点：別run/別root、偽file、symlink/置換、recover後の改変、同時resume。拒否時spawn0・他sessionのlease不変をassert。

## 3．限定認可

### Task 1: 再現とprivate exact-file契約
**Files**：新規 `src/runs/shared/recovered-nested-session.ts`。
変更：`nested-recovery.ts`、`subagent-executor.ts`、既存の`child-runtime-config/child-launch/async-execution/runner-child-launch/subagent-runner`のprivate pipe。
試験：`test/unit/nested-recovery.test.ts`、関連nested resume検査。

**Interfaces**：`RecoveredNestedSession`はrunId/agent/ownerRunId/rootRunId/canonicalSessionFile・file identity・status/descriptor digestを持つ非公開DTO。
validatorは現物とDTOを照合して当該fileを認める。公開tool引数に出さず、既存rootを追加・変更しない。既存native回復bindingが無い呼出しへ許可しない。

- [x] Task別保存先、run名directory内の有効fileで、既存validator拒否をREDにする。
- [x] recoverの全対象lease保持中に、所属済みsessionの証拠を捕捉。regular/canonical/owner配置・descriptor/status一致も確認。
- [x] verified private binding→managerのnative runtimeへ伝播。孫のinherited runtimeから除く。
- [x] resumeでrun/root/owner/agent/file/現物digestを再照合。従来のregular file・symlink・owner配置・排他lease検査は残す。
- [x] canResumeも同じ認可条件へ揃える。証拠不足時にtrueを出さない。
- [x] 他run/他root/別file/改変/置換/公開引数/孫への継承を拒否しGREEN。通常のroot内resumeを維持。
- [x] 型検査・関連単体・新規変更のlintを実行しcommit。既存lint負債は差分と分ける。

## 4．実resume検証

### Task 2: 実manager→旧coderの実resumeまで検証
**Files**：`test/integration/nested-recovery.test.ts`、`test/fixtures/native-nested-recovery-provider.ts`、tool-referenceの限定契約説明。

- [x] 実SDKで旧managerが別Task cwd/sessionDirへ子を起動しtimeout。実際の保存fileを用いる（原本コピーなし）。
- [x] 元親recover→managerの正規resume→旧coderの正規resume→ローカル応答の消費→coder/manager close→lease freeまでassert。status取得だけで合格にしない。
- [x] 元コードではoutside trusted rootsでRED、修正版はGREEN。import失敗やskipを実証と数えない。
- [x] 別managerの子は実resume拒否、正当な子は一度だけdispatch、同時resumeは片方拒否。
- [x] proofと旧failed state不変、model/tool/予算不変、他sessionのlease不変、global trusted roots不変。
- [x] 全unit/integration/typecheck＋native非skipを実行。各commandのexit/log hash/source hashをreceipt化。
- [x] 独立確認1件。会話・報告はworktree、tool生成async管理記録/runnerログだけ既定system tempの今回例外を適用。

## 5．判定・次のアクション
| 項目 | 現在 |
|---|---|
| F001 | 停止・部分成果保全、既存54test成功のみ |
| 追加修正 | 実装・隔離検証済み。単体4043成功/17skip、統合1194成功/12skip、失敗0。実Pi旧子resumeも1成功/skip0。独立確認OK with notes |
| 共有反映・F001再開 | この承認には含まない |

- [ ] Task 1→2。製品修正はこのライブラリ内だけ。部署やRoot全体の信頼を広げない。
- リスク：file証拠だけで権限を作らず、既存private回復bindingに限定。保存元の真正性を証明できなければblocked維持。
- 残余リスク：試験は検査途中のdescriptor/file置換と同root別run拒否を含む。任意の同一UIDによる非協調的filesystem namespace変更を完全に排除するsandboxとは扱わず、実resume時の既存lease検査を維持。
- 未解決のユーザー判断：なし（追加修正・隔離検証の範囲）。新固定copy導入・reload・実F001再開は結果提示後に別承認。

### 決定ログ・出典
- f1a605b8：trustedSessionRootsForStatus／resolveRequestedResumeTarget／validateNestedSessionFile、child runtime private binding。
- 元親のnode-slice-blocker報告と実TAP54 pass/0 fail/skip0・exit0を読み取り確認。旧run/製品を変更せず。
- 本人がplan解除・保存・親直接実装・隔離検証・最後の独立確認1件（管理記録保存例外含む）を承認。
