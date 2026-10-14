# 1．親のruntime担当定義を子へ渡す設計

> 作成／更新：2026-10-14。出所：pi-subagents固定HEAD `77cfc3db880522910f69507ead69fa7c4a6df0f8`、公式extension-api、Epic #27 Implementation親の実run報告。
> 目的：親に登録されたProfile担当をmanager子からも解決できるようにし、許可範囲・監督・実行証拠を維持します。製品編集はまだ行っていません。

## 目次
1. 一言サマリー
2. 決定事項
3. 現状と変更境界
4. 引き渡しと安全条件
5. 合格基準
6. 判定・次のアクション
7. リスク・残る空白・出典

## 1．一言サマリー

**親が登録済みのruntime担当を、子の許可範囲に絞った固定コピーとして既存launchへ渡します。** 子は通常の登録検証を通し、list・models・起動解決に同じ定義を使います。別CLI、静的定義コピー、既存runのdescriptor編集で回避しません。

## 2．決定事項

| 論点 | 決定 | 理由・補足 |
|---|---|---|
| 修正箇所 | **pi-subagentsのnative launch／runner境界** | Profile定義のallowlist修正だけでは親の登録は子へ移りません |
| 方式 | **親所有の登録済み定義を固定して渡す** | 2026-10-14、本人が選択。全Profile拡張の再起動や二重管理を避けます |
| 許可 | **既存allowedAgentsと能力上限を維持** | 定義が見えることを新たな起動・工具・拡張・モデルの許可にしません |
| 検証 | **RED→境界試験→隔離native runtime** | モデル報告や親のlistだけで子の動作を合格にしません |
| 操作範囲 | **専用worktreeだけ、配布・Git統合は別承認** | Epic #27製品writerと共有設定を保護します |

## 3．現状と変更境界

【事実／確度：高】親の `src/extension/index.ts:483–500` は親のpi所有registryを探索結果へ合成します。`src/extension/fanout-child.ts:200–214` は子のexecutorに静的 `discoverAgents` を渡します。`src/runs/shared/child-launch.ts:48–61` の継承値は深度・上限・経路・required extensions等だけで、担当定義を含みません。公式 `docs/extension-api.md` はruntime登録をprocess-localと明記しています。

【実run報告】親のProfile3担当はlist/modelsに存在。manager子 `572b04bc-3a15-4e9e-a7a2-cd9164a0de31` のlist/modelsにはcoder/testerがありません。descriptorには正規canonical allowedAgents、深度5、nested許可、監督/待機工具があります。拡張はpi-lens/pi-gh、ambient無効、requiredは空。製品/Issue書込み・孫起動は0との報告です。終端・lease解放はImplementation親が正規run管理で別確認します。

変更する境界：runtime registryの固定コピー作成／検証、executorからforeground/background launchへの受け渡し、runner入力とrecoveryの固定保持、child runtime登録と探索、対応テスト・公式説明。

対象外：Epic #27の仕様/製品/Issue、pi-profileの再選択、外部CLI/remote、新しい監督機構、既知のget単独runtime探索漏れ、共有設定/認証変更、既存runのdescriptor/registryの手編集、実環境配布、push/公開。

## 4．引き渡しと安全条件

```text
親のpi所有runtime registry
  → 子のcanonical allowedAgents ∩ 継承された能力上限で選別
  → version 1の固定コピー
  → 既存foreground/background launchと正規runner入力
  → 子のpi所有registryへ通常の検証で登録
  → 子list/models/起動解決
```

### 固定コピー

- 候補はその親piが登録したruntime定義だけ。モデル入力に新規担当定義を受け付けるパラメータは追加しません。
- 登録名、本文、工具、除外工具、拡張、モデル/強度、context、継承、許可担当等を登録時の正規形で保持します。省略値を推測で補いません。親の設定によるモデル解決と通常の子の設定解決を維持し、固定担当指定を変更しません。
- canonical名で選別します。allowedAgentsが空なら0件。未指定なら既存の能力上限に従います。制限は積集合で狭めるだけです。子がさらに委任するときも再選別し、除いた定義を後から取り戻しません。
- Snapshotはversion 1、担当配列、最大200担当、UTF-8 JSON総量1 MiB以下。登録済みでも容量を超えればlaunch前に拒否し、切り捨てません。既存の定義フィールド検証・上限も維持します。
- 定義を深くコピーし、親の配列/本文/工具の後続変更が準備済みlaunchに反映されないようにします。aliasや未知項目の衝突を黙って優先しません。

### 子での登録・探索

- fanoutを許可されたnative子だけが継承定義を受け取ります。末端coder/testerの工具や委任権限は増やしません。
- 子のpi ownerに既存の正規登録検証を通して登録します。グローバルWeakMapやowner nonceを外から書き換えません。
- 子の静的発見結果と継承runtime定義を既存の衝突/能力検査で合成し、list、models、executor起動で一致させます。get単独の既知漏れは今回直しません。
- tools、excludeTools、extensions、allowedAgents、maxDepth、thinking、permissions等の既存launch gateをそのまま通します。登録された定義があってもgateが拒否すれば起動しません。
- reload/shutdown/disposeでその子ownerの登録だけを解放します。別ownerや親の登録に触れません。初期化の途中で登録に失敗したら、この試行で作った登録を解放して拒否します。

### runner／recovery

- foregroundとbackgroundは同じ固定コピー作成・検証・子登録を使います。
- runner入力と正規recovery記録は作成時の固定コピーを保持します。許可されたresumeでは保持した値を再検証して使い、親の現行registryを勝手に取り直しません。
- 既存runの記録を書き換えません。継承定義を持たない従来の起動では、静的担当発見を維持し、runtime担当の存在を捏造しません。別の互換モードは作りません。
- snapshotは内部入力であり、信頼できない入力からの形式/容量/重複/衝突を拒否します。run/session/能力上限等の既存所有権確認を省略しません。
- 定義本文や秘密候補を診断・通常ログ・第三者サービスへ出しません。表示するのは担当名、件数、結果、固定ref等です。

## 5．合格基準

1. 親registryにmanager/coder/testerがありmanagerにcanonical coder/tester許可がある入力 → manager子のlist/models/起動解決がその2定義を見つける。旧refはこの検査で不合格。
2. 親の別owner登録・許可外担当・allowedAgents空 → 引き渡し0件または許可された分だけ。起動許可を拡大しない。
3. tools/excludeTools/拡張/モデル/強度/本文等 → launch前後で内容保持。末端にsubagent/ask_userを足さない。
4. 親の定義をcapture後に変更/解除 → 子に渡す本文と工具はcapture時の値。recoveryも同じ。
5. 不正version/未知または不正フィールド/重複canonical名/alias衝突/200件超/1 MiB超 → launch前または子初期化で拒否、子・孫起動0。
6. 登録途中失敗・dispose → この子の登録だけを解放し、親/別owner不変。
7. foreground/backgroundおよびrecovery → 同じ制限・同じ固定定義で解決。静的担当だけの既存試験を保持。
8. 隔離SDK/native runnerで親登録→manager子登録→coder/tester解決を確認。registryへの試験用直接編集や偽の成功reportを使わない。モデル通信なしの検査と、実モデル起動の検査を区別して報告する。
9. 関連unit/integration、全unit/integration、型検査、既存lintコマンドがあるならその結果を提示。未実行・既存不合格を隠さない。

## 6．判定・次のアクション

| できていること | できていないこと |
|---|---|
| 一次ソースと実run報告の境界照合、方式の本人選択 | 設計文書の本人確認、実装計画、製品修正、回帰/実runtime検証 |

> 判定：△ 設計案。子の担当解決やEpic #27再開の成功はまだ主張しません。

- [ ] 本文を自己レビューし、本人が設計文書を確認。
- [ ] 実装計画を作り、編集・検証方法の承認を得る。
- [ ] TDDで限定実装、全体検査、独立レビュー。
- [ ] 配布方法・対象・Git操作を別承認し、本人の正規reload後に実親/子の工具・担当解決を確認。
- 後回し（2026-10-14）：get単独のruntime探索漏れ、外部CLI/remote対応、Epic #27製品の実装。

## 7．リスク・残る空白・出典

| リスク | 対応 |
|---|---|
| snapshotで権限が広がる | owner限定、canonical名選別、能力上限の積集合、通常launch gateで再拒否 |
| 定義を複製して状態がずれる | captureを固定し、foreground/background/recoveryを共通化 |
| large promptでrunner入力が肥大 | 200件/1 MiB、容量超過はlaunch前拒否、切り捨てなし |
| shared packageを無断で更新する | 専用worktree、未配布、Git/配布は別承認 |
| 静的試験だけで再開成功とする | 実native境界の検査と実親/子の再確認を分ける |

残る空白：実装計画のファイル境界と最小検証fixture、依存導入/実環境配布/Git統合の許可。安全条件・対象・完了条件を実装担当が推測で拡げません。

出典：`AGENTS.md`、`VISION.md`、`docs/extension-api.md`、`src/extension/index.ts`、`src/extension/fanout-child.ts`、`src/agents/runtime-agent-registry.ts`、`src/runs/shared/child-launch.ts`、`src/runs/shared/child-runtime-config.ts`、`src/runs/background/runner-child-launch.ts`、Implementation親のworkflow1736a826／child572b04bcの一次報告。

決定ログ：2026-10-14、本人がrunner修正を別scopeで承認。計画モードで一次調査し、runtime担当の限定固定コピー方式を本人選択。本人承認で計画モードを解除し専用worktreeに本設計だけを保存。依存導入・commit/push・配布・実子起動・製品編集は未実施です。
