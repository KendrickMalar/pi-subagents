# runtime担当定義引き継ぎ 実装計画

> 作成／更新：2026-10-14。出所：本人承認済み設計、固定HEAD 77cfc3db880522910f69507ead69fa7c4a6df0f8。
> For agentic workers: 承認された方法だけで実行します。各単位はRED→最小修正→GREEN。製品編集・依存導入・配布・Git操作は、この計画の保存だけでは許可されません。

**Goal:** 親に登録済みで許可範囲内のruntime担当を、native manager子のlist/models/起動解決へ安全に渡す。
**Architecture:** 親ownerの正規定義を選別・固定し、既存foreground/background launch、runner、recoveryを通す。子ownerへ通常の登録検証で登録する。
**Tech:** 現行TypeScript/Node、既存lock・npm scripts・native SDKと既存試験fixture。新しい依存・別runner・互換モードなし。
**Spec:** `docs/superpowers/specs/2026-10-14-runtime-agent-inheritance-design.md`。

## 1．制約とレビュー焦点

- 作業：管理下専用worktree `fix-runtime-agent-inheritance`、1 writer。共有配置やEpic #27製品は編集しない。
- 200担当、UTF-8 JSON 1 MiB。容量/形式/衝突違反は拒否、切り捨てなし。
- 親owner限定、canonical名、allowedAgentsと能力上限の積集合。工具/拡張/モデル/深度/permissionsの通常gateを維持。
- 既存runのdescriptor/registry/nonceを手編集しない。新launchの正規保存と許可されたresumeだけを変更。
- 外部CLI/remote、get単独の既知漏れ、Profile再選択、共有設定/認証/依存更新は対象外。
- 試験HOME/TMPDIR/成果はworktree内。実ユーザーの設定/認証/registryを使用しない。正常/異常のログを保持。
- 初期検証でモデルを呼ばず、実manager/孫を起動しない。実環境配布・実親の再開は別確認。

| 見落としやすい境界 | 合格結果 | 担当単位 |
|---|---|---|
| 親の別ownerやcapture後の変更 | 別ownerを含まず、capture時の本文/工具を保持 | A |
| 子へ許可した2担当と無関係な3番目 | 2担当だけ解決、空許可で0、孫へ権限追加なし | A/B |
| 手編集/不正/巨大runner入力 | version/容量/形/衝突の拒否、起動0 | A/C |
| recoveryが親の現行定義を取り直す | capture時の値を再検証して復元 | C |
| childのlistと起動が別の探索を使う | list/models/executorが同じ登録済み2担当を見る | B/D |

## 2．単位A：固定コピーの作成・検証

**Files:** `src/agents/runtime-agent-registry.ts`、新 `src/agents/runtime-agent-snapshot.ts`、`test/unit/runtime-agent-registration.test.ts`、新 `test/unit/runtime-agent-snapshot.test.ts`。
**Consumes:** 親ExtensionAPI owner、既存正規RuntimeAgentDefinition、子のResolvedSubagentCapabilityCeiling。
**Produces:** `RuntimeAgentSnapshot`（version:1、agents: {name,definition}[]）、capture/filter/validateの共通関数。既存の正規定義検証を再利用し、二重のfield仕様を作らない。

内部関数の契約：`captureRuntimeAgentSnapshot(pi: ExtensionAPI, ceiling?: ResolvedSubagentCapabilityCeiling): RuntimeAgentSnapshot`、`validateRuntimeAgentSnapshot(value: unknown): RuntimeAgentSnapshot`、`filterRuntimeAgentSnapshot(snapshot: RuntimeAgentSnapshot, ceiling?: ResolvedSubagentCapabilityCeiling): RuntimeAgentSnapshot`、`registerRuntimeAgentSnapshot(pi: ExtensionAPI, snapshot: RuntimeAgentSnapshot): {dispose(): void}`。capture/filterは正規登録名と許可積集合を使い、量の検査は選別後。validate/registerは形・量・衝突を通常の定義検証と共通化する。

- [ ] RED：親と別ownerへ異なる3担当を正規登録。capture/filter結果はcanonical許可のcoder/testerだけ。空許可は0。
- [ ] RED：本文/tools/excludeTools/extensions/model/thinking/allowedAgentsをcapture後に変更しても固定コピー不変。
- [ ] RED：不正version、未知/不正field、重複/alias衝突、201担当、1 MiB超は拒否。
- [ ] 最小実装：正規形から深くコピー、選別後の量を検査、変更不能な値として返す。registry全体や他ownerは変更しない。
- [ ] 対象unitを実行。tools/本文等を通常ログへ出さず、件数/名/結果だけ記録。

## 3．単位B：native childの登録・共通探索

**Files:** `src/runs/shared/child-runtime-config.ts`、`src/runs/shared/child-launch.ts`、`src/extension/fanout-child.ts`、必要最小限の `src/extension/index.ts`、`test/unit/child-runtime-config.test.ts`、`test/unit/child-launch-plan.test.ts`、`test/unit/nested-control-fanout.test.ts`。
**Consumes:** Aの検証済みsnapshot、最終交差済み能力上限、既存native child hooks。
**Produces:** child configの固定snapshot、子ownerの正規登録/dispose、親/子で同じruntime合成探索。

- [ ] RED：fanout child hooksにsnapshotを渡すとlist/models/executorがcoder/testerを解決できる。旧コードは不在で失敗。
- [ ] RED：非fanout子、許可外、能力上限で除外された担当は渡さない。coder/testerの工具/委任許可は不変。
- [ ] RED：登録の途中失敗とdisposeでこの子の登録だけを解放。親/別ownerに影響0。
- [ ] 最小実装：child config/共通launchへsnapshotを追加し、子ownerへ既存登録APIで登録。静的discoveryとruntime合成の既存検査を使う。
- [ ] 対象unitを実行し、session shutdown/reloadの解放、existing required extensions・owner barrier・深度制限が不変か確認。

## 4．単位C：foreground/background/recovery配線

**Files:** `src/runs/foreground/execution.ts`、`src/runs/foreground/subagent-executor.ts`、`src/runs/background/async-execution.ts`、`src/runs/background/runner-child-launch.ts`、`src/runs/background/async-resume.ts`、`src/runs/shared/parallel-utils.ts`、`src/shared/types.ts`。必要なら既存 `src/runs/background/subagent-runner.ts` のconfig検証に同じvalidatorを接続。
**Tests:** `test/unit/async-recovery-descriptor.test.ts` と対応する既存foreground/runner launch試験。変更箇所を広げる前に、共通型・builderだけで通るか確認する。
**Consumes:** 起動元pi ownerとA/Bの共通関数。
**Produces:** 既存foreground options/RunnerSubagentStep/runner input/recoveryに固定snapshotを引き渡す。モデル向けtool入力には新しい自由な定義入力を追加しない。

- [ ] RED：両launch builderのchild configが同じ2担当・同じ本文/工具/モデル指定を受け取る。
- [ ] RED：runner/recoveryのJSON round-tripがsnapshotを保持。resumeで別の現在registryを参照しない。
- [ ] RED：runner入力の不正/巨大snapshotは子初期化またはlaunch前に拒否、子・孫起動0。
- [ ] 最小実装：親でcapture、子の最終policyで再filter、正規runner/recovery保存・読込にvalidatorを接続。継承のたびに上限を狭める。
- [ ] snapshot無しの既存静的担当、chain/parallel/append/resumeの関連試験を実行。別の互換モードは作らない。

## 5．単位D：実native境界検査と説明

**Files:** 新 `test/integration/runtime-agent-inheritance.test.ts`、`docs/extension-api.md`。試験用script/ログはignored作業領域だけ。
**Consumes:** 正規runtime登録API、実SDKとchild session factory、B/Cのlaunch config。
**Produces:** モデル通信なしの親→manager子→coder/tester解決の証拠。process-local登録そのものと明示されたlaunch継承を説明。

- [ ] RED/GREEN：隔離SDKに親の3担当を正規登録し、正規native launch factoryでmanager子を初期化。子list/models/起動解決が許可2担当だけ返す。既存registry/descriptorへの手編集は禁止。
- [ ] SDKの実API/loader aliasを使い、synthetic HOME/cwd/TMPDIR、in-memory settings/session、空credentials、通信拒否で試験。初期化失敗を成功reportに置き換えない。
- [ ] 模擬model metadataと本物model呼出しを区別し、初期検証のmodelRequests/実子の製品操作が0であることをassert。
- [ ] docsへnative launch継承の対象・許可選別・容量・cleanup・外部/remote対象外を追記。モデル用の登録API拡張やget修正は入れない。
- [ ] 全体を検証し、独立読み取りレビュー。重大/重要指摘は修正後に再検証。

## 6．検証コマンド

既存lock固定の検証環境導入は別承認後に `npm ci --ignore-scripts`。store/cache/TMPDIRはworktree内。test fixtureが作った専用領域の既存cleanup以外、削除を追加しない。検証ログはcleanup対象外へ保存。

```sh
npm run typecheck
npm run test:unit
npm run test:integration
```

`PI_SUBAGENTS_TEMP_ROOT` と `TMPDIR` をworktree内の試験rootへ固定する。既存 `test/support/isolated-temp-root.mjs` のHOME隔離を使用する。もし長いHOME/socketや試験fixtureの前提で阻害されたら、失敗ログを保持し、期待値や安全検査を弱めずにfixture境界を確認する。既存lint入口はpackage.jsonに無いため、存在しないlintコマンドの実行を主張しない。

合格：各コマンド終了コード0、必要ケースのfail/unverified/skipなし、旧refの対象REDと新refのGREEN、親/子の制限保持。全体に既存不合格があれば、原因・件数をそのまま提示し配布を止める。

## 7．自己レビュー・残りの承認

設計の9基準はA（1〜5）、B（1〜3/6）、C（4/5/7）、D（1/2/8/9）で確認する。本文/工具の固定保持、許可積集合、既存run非変更を各境界でassertする。

- [ ] 本計画の本人確認と実行方法を確定。
- [ ] 検証用依存導入、架空fixtureの作成/既存cleanupを承認。
- [ ] 実装・独立レビュー・全体検証。
- [ ] Git保存/実環境配布/reload/実run再開を、対象refと影響を示して別承認。

残る空白：実環境への反映方法とGit操作の許可、元のblocked childの終端/lease確認（Implementation親の担当）。これらは製品修正の完了と分けて扱う。
