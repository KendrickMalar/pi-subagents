# 入れ子runの安全な復旧 実装計画

> 作成日・最終更新：2026-10-15
> 出所：KnoudeCode F001の停止記録、導入済みpi-subagentsの実装、本人の設計選択。
> 目的：部分成果を捨てず、元の親セッションから正規管理経路で再開可能にします。
> 実装方式：本人承認により、この親が直接実装し、最後にfresh-contextの独立確認を行います。共有環境への導入・元タブ反映は別承認です。

**目的**：親が明示的な復旧操作で旧子の所属・終端・再開条件を照合でき、権限を広げず元managerへ管理範囲を引き継げるようにします。

**構成**：通常のstatus/resumeの権限境界は変えず、親専用のrecover操作を追加します。既存のnested event処理、reconcile、終了証明、session lease、復活処理を再利用します。別runner・別CLI・第二のlease機構は追加しません。

**技術**：TypeScript、Node標準テスト、既存Pi SDKとネイティブrunner。実環境のPi 1.1.0でも隔離fixtureを確認します。

**仕様**：[VISION.md](../../../VISION.md)、本書、停止した元親の非公開checkpoint。導入済みコードと対応を確認した起点は `7dcceb18f751d8ce79a643529073cf7a67d988a6` です。

## 目次

1. 事実・決定事項
2. 共通制約・レビュー重点
3. 復旧操作の契約
4. 実装単位と検証
5. 実環境への反映・再開
6. 判定
7. 次のアクション
8. リスク・残る空白
9. 出典・決定ログ

## 1．事実・決定事項

| 論点 | 決定／確認できた事実 | 理由・限界 |
|---|---|---|
| 導入版 | **7dcceb18を起点に修正** | nested-events、run-id-resolver、session-lease、fanout-child、subagent-runnerの5ファイルが導入コピーと同一hash。別の古いcloneを修正しません。 |
| 作業先 | **新worktree・fix/nested-run-recovery** | 既存rti worktreeとその.workは別件として保持します。 |
| API | **元の親が明示的にrecoverを実行** | 本人が選択。通常status/resumeの検索権限を全runへ広げません。 |
| 状態差 | **子statusはfailed、registryはrunning、未反映のfailed eventあり** | 保存済み原本を読み取り確認。実行成功や受け入れ合格ではありません。 |
| 終了証明 | **runner observedと別writerの証明を分ける** | 現行runnerはPiを同一プロセス内で実行しexpectedWriters=0を保存します。この場合のstep not-startedだけで不足と断定しません。別プロセスwriterの未知・不足は合格へ変換しません。 |
| 実タブ反映 | **この計画の実装合格後、別途承認** | ランチャーのsource集合はプロセス固定。reloadだけで新パスへ切替できるとは扱いません。 |

## 2．共通制約・レビュー重点

- 修正元repo：`~/.pi/agent/git/github.com/KendrickMalar/pi-subagents`。
- 作業worktree：`~/.config/superpowers/worktrees/pi-subagents/nested-run-recovery`。
- 起点の既存機能、SDK固定依存、model/tool/ceiling/budgetを維持。any禁止。
- 本番runtimeのJSON・route・proof・leaseを手で変更しない。PID kill・ロック削除・別CLIで迂回しない。
- KnoudeCodeの製品・テスト・未コミット成果をこの修正で編集・統合しない。
- 元の実装親タブを停止・再起動・移行しない。共有設定・導入コピーは反映承認まで変更しない。
- ログ・HOME・TMPDIR・PI_SUBAGENTS_TEMP_ROOTは新worktreeの非追跡領域。既存runtime原本は読み取りだけ。
- 固定lockの依存導入と隔離検査は本人承認済み。npm ci --ignore-scripts --no-audit --no-fundで129 packages、package/lockの変更なし。
- 復旧操作は子を起動しない。実際のresumeは別の明示操作で、既存の排他lease検査を必ず通す。
- 各TaskはRED/GREENのログ、対象差分、検証済みcommitを残して引き継ぐ。実行していない検査を合格にしない。

### レビュー重点

1. 別親・別manager・別root・偽の所属記録で、他の作業を復旧／閲覧できないこと。
2. runner終了だけで、別プロセスwriterや所有中sessionを解放扱いにしないこと。
3. 新旧イベントの順序・再実行でfailedがrunningへ戻らず、二重の再開権限を発行しないこと。
4. manager復活で引き継ぐのは検証済み旧子だけ。新managerのmodel/tool/予算を変更しないこと。
5. 通常のstatus/resumeに全registry走査を追加しないこと。明示指定したrootだけを調べること。

## 3．復旧操作の契約

予定する公開口：

```ts
subagent({
  action: "recover",
  id: "<元managerの完全なrun ID>",
  nestedRootRunId: "<管理対象rootの完全なID>"
});
```

- prefix、任意dir、force、別model/tool指定、agent/task/workflowとの混在を拒否します。
- child-safe runtimeでは、ファイル読取り・変更前に拒否します。
- 元managerの親sessionが現在の親sessionと一致することを、正規statusとcanonical session情報で検査します。
- 指定rootのroute/token、イベントのparent、子status、launch/revivalの所属証拠・共有fanout budgetのidentityを照合します。ユーザーの文章や同じcwdだけを証明にしません。
- `/var`と`/private/var`の正当な同一実体は区別しつつ、許可外へのsymlinkやnamespace逸脱は拒否します。
- 所属証拠が不足する旧形式は、推測で採用せずblockedを返します。
- 所属確認後だけ、既存projectNestedEvents/reconcile処理で状態を照合します。終了結果をcompleteへ変えたり、unknown proofを書き換えたりしません。
- 生存中・proof不足・session lease所有中／読取り不能なら復旧可能と表示しません。PID不在だけでは十分としません。
- ネイティブPiの同一runner内実行は、当該実行経路・runner instance・終了証明が一致する場合に限り、別writerの記録が適用外であることを明示します。rawのstep not-startedは書き換えません。
- 復旧結果には対象ID、lifecycle、runner証明、writer証明の適用可否、lease状態、再開可否、拒否理由を返します。tokenやsystem promptは返しません。
- 検証済み管理範囲の引き継ぎ記録は既存のprivate revival/監査領域を使い、元親・元manager session・対象rootへ固定します。通常resumeはこれを再検査し、元managerの続きを起動するときだけ旧子の範囲を渡します。
- 復旧の繰返しで範囲を広げず、同じ履歴へ重複writerを起動しません。記録が変わった場合は再検査します。

## 4．実装単位と検証

### Task 1：今回の停止を隔離fixtureで再現

**作成**：`test/unit/nested-recovery.test.ts`。
**参照**：`test/unit/nested-events.test.ts`、`run-id-resolver.test.ts`、`stale-run-reconciler.test.ts`、`session-lease.test.ts`。

- [x] 合成run ID・新規fixture rootを使い、terminal child status＋未反映event＋古いrunning registryを作る。本番のtokenや原本を複製・変更しない。
- [x] 元親の管理ルートが失われ、旧子へのstatus/resumeが到達できないケースを再現する。
- [x] 別親、manager/rootの不一致、改ざんproof、所有中lease、child-safe caller、path逸脱を拒否するテストを先に追加する。
- [x] 既存executorにrecoverを呼び、unknown actionと期待するrecovered/blockedの不一致でREDを確認する。単なる新moduleのimport失敗や環境初期化エラーを再現成功にしない。

### Task 2：親専用recoverと管理範囲の引き継ぎ

**新規**：`src/runs/background/nested-recovery.ts`。
**変更候補**：`src/extension/schemas.ts`、`src/shared/types.ts`、`src/runs/foreground/subagent-executor.ts`、`src/runs/background/async-resume.ts`。
**必要時のみ**：`src/runs/shared/nested-events.ts`、既存recovery descriptor／child runtime configの型。変更が広がる場合は実装前に範囲を見直す。

公開する内部口：`recoverNestedRunTree(request, context): Promise<NestedRecoveryResult>`。
requestはownerRunId/nestedRootRunIdだけ。contextはホストが与える親session・固定runtime roots・既存状態／検証依存で、ツール入力から受け取らない。
resultはrecoveredまたはblockedの判別unionとし、上記契約の証拠・拒否理由を持つ。例外の握り潰しや成功風の空配列を使わない。

- [x] 所属検査・native proof・lease検査を既存関数へつなぎ、照合前のmutation/launchを0回にする。
- [x] 検証済みの元親管理対象だけを復元する。全registry検索へのfallbackを追加しない。
- [x] 元managerのresumeへ、旧子の限定範囲を正規runtime契約として引き継ぐ。任意の文章やextensionBindingsによる権限追加は使わない。
- [x] Task 1をGREENにする。既存の別親拒否・child subtree制限・排他leaseのテストを維持する。
- [x] 次の失敗条件もassertする：live/unknown/lease-ownedはblocked、resume呼出し0回、モデル・ツール契約不変。

### Task 3：実Piで終了・復旧・再開を確認

**新規**：`test/integration/nested-recovery.test.ts`、`test/fixtures/native-nested-recovery-provider.ts`。
**変更**：`docs/tool-reference.md`のaction説明。導入済みfixtureと混同しない。

- [x] 実SDK/ネイティブrunnerとローカルの決定的providerを使い、manager timeout→子の終端→元親recoverを通す。外部API・実認証・shareを使わない。
- [x] recoverだけではspawn 0回、明示resumeで1回、同じsessionへの同時resumeは片方拒否をassertする。
- [x] 復活managerが検証済み旧子へ到達し、別manager・別route配下のnested子には到達しないことを確認する。既存top-level asyncの読み取り診断を新たに制限しない。
- [x] actual close proof・lease解放・結果消費・管理reportの順序をログに残す。managerのexit 0だけで合格にしない。
- [x] 型検査、関連単体、全単体・統合を実行する。実Pi fixtureのskipは実動作の合格に数えない。
- [x] 宣言SDKと実Pi 1.1.0の違いを記録する。SDK依存を無断更新せず、実ホストfixtureを別の証拠にする。

承認時の検証コマンド（実行時は隔離preloadを追加。実結果は§6）：

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/nested-recovery.test.ts test/unit/run-id-resolver.test.ts test/unit/stale-run-reconciler.test.ts test/unit/session-lease.test.ts
npm run test:all
```

native fixtureは既存register-loader/native-peer-loader手順を読んで実行する。必要なPI_SUBAGENTS_NATIVE_PI_ROOTを指定し、実行件数と非skipを確かめる。lintは既存oxlint設定・実CLIのオプションを確認して追加変更ファイルへ実行する。存在しないnpm lint scriptは捏造しない。

## 5．実環境への反映・再開

この段階は修正・隔離検証の合格後、対象と影響を示して別途承認を得ます。

- [ ] 旧7dcceb18コピーを保持し、検証済みcommitの新しい固定コピーを作る。旧パスの中身を上書きしない。
- [ ] 原本・部分worktree・認証・policy・許可ファイル・他Profileの不変を確認する。
- [ ] 元親のsessionとScaffold Implementation受領記録を保持する反映手順を、隔離セッションで検証する。
- [ ] 単なるreloadや新タブで元親の権限を継承したと仮定しない。再起動／同工程移行が必要なら、禁止規律との衝突を明示して本人へ別途確認する。許可前に元タブを止めない。
- [ ] 反映が正規に確認できた場合だけ、元実装親からrecoverを実行し、readbackと再開可否を確認する。
- [ ] managerをまず保全・限定再開する。Nodeの小さい修正単位→Swiftの小さい修正単位→独立検証→Feature統合へ分ける。30分manager一括の反復や、期限延長だけを対処にしない。
- [ ] KnoudeCodeの既存53/54とformat不合格は古い結果として保持し、補正版suiteと現在の製品で検査し直す。合格前に統合・close・後続着手しない。

## 6．判定

| 項目 | 現在 |
|---|---|
| 導入版・元ソースの対応 | 5主要ファイルのhash一致を確認 |
| 部分成果・終端記録 | 原本を変更せず存在確認 |
| 新recover | 独立レビューのP1/P2を再現・修正。全単体4030成功・全統合1194成功、失敗0。実Pi1.1.0も1成功・skip0。独立再確認はOK with notes（既存lint負債・共有反映未実施） |
| 実タブへの反映 | 未承認・未実施 |
| KnoudeCodeの再開 | 未実施 |

検証の詳細（非公開ログは専用worktreeの `.superpowers/sdd/2026-10-15-nested-run-recovery/`）：
- レビュー修正後：`verified-review-fixes-all-0.log`で単体4030成功/17 skip、統合1194成功/12 skip。`verified-review-fixes-native-0.log`で実Pi1成功/skip0。型・新規4ファイルlint・diff checkもexit0。各同名JSONに開始/終了hash、exit code、ログhashを記録し、現物との一致を確認しました。
- 独立レビューのlease競合とparentPath不一致はREDで確認しました。既存leaseを全対象sessionに取得したまま終端を再検査し、投影とauditを公開します。部分取得時は自分の分だけを解放します。別プロセスの競合拒否、検査後proof変更の拒否、lease namespaceのsymlink拒否も検証しました。
- `full-suite-final-1.log`：隔離preload付きの `npm run test:all`、単体4023成功/17 skip、統合1194成功/12 skip、失敗0・exit0。
- `task-3-native-7.log`：実Piで復旧単独の起動0、同時resumeの片方拒否、元の子のstatus消費、別managerのnested子拒否、close証明・lease解放を確認。
- `native-base-final-red.log`：元commitの同一fixtureは `Unknown action: recover` で失敗。既存原本は変更していません。
- `typecheck-final-2.log`：型検査exit0。新規4ファイルのstrict lintもexit0。
- 全変更ファイルのlintは既存負債を含むため不合格です。起点1374件→現在1372件、新規指摘0（`lint-delta.json`）。ルールや上限は緩めていません。

> この計画は復旧成功の証拠ではありません。所属証明が足りない旧runを、成功に書き換えて再開しません。

## 7．次のアクション

- [x] 本書を本人が確認し、実装方式とinstall/隔離試験の範囲を承認する。
- [x] RED→最小実装→GREEN→独立確認を行う。P1/P2修正後も同じ担当が独立再確認済み。
- [ ] 合格後に反映方法を確定・別承認し、元親で限定再開する。

## 8．リスク・残る空白

- 元親の持つ正当な管理情報が、旧成果物だけでは証明できない場合があります。その場合はblockedのまま報告し、明示的な別の管理引き継ぎを検討します。
- live Piのランチャーsource固定とScaffold工程受領の維持は、今回まだ実証していません。実タブで試行錯誤しません。
- Unix socketのパス長など、worktree内の隔離HOMEに制約があります。失敗を理由に実HOMEやシステム一時領域へ勝手に切り替えません。
- runtimeの変更は他案件へ影響し得るため、共有環境への適用と旧タブへの操作は計画承認だけで許可されたと扱いません。
- 事業上の撤退基準：未設定。技術上は、所属・終了・lease・受け入れのどれかが不明なら止めます。

未解決：元実装セッションの工程記録を保持した反映方法と、その実施承認。修正の独立指摘は解消済みです。

## 9．出典・決定ログ

- pi-subagents 7dcceb18のVISION、tool-reference、nested-events、run-id-resolver、subagent-executor、stale-run-reconciler、session-lease、process-terminal、subagent-runnerを確認。
- KnoudeCode Epic worktreeの非公開f001-supervision-blocker.md、管理回収report、保存status/proof/eventを読み取り確認。実token・session本文・原本コピーは本書に含めない。
- 2026-10-15：本人がpi-subagents修正計画、元親の明示recover、専用worktreeでの計画保存を選択。
- 同日：worktree後npm install規律との衝突を明示し、計画保存時だけ導入保留の例外を本人が承認。
- 同日：本人が計画・親の直接実装＋最後の独立確認・固定依存と隔離試験を承認。
- 同日：独立レビュー1件だけ、ツールが自動生成するasync管理記録・runnerログの既定システム一時領域への保存を例外承認。会話ログ・報告はworktree内。共有設定変更や元タブ反映の承認ではありません。
- 同日：本人が同じ独立担当への修正後再確認1回と管理記録保存の例外を追加承認。担当はP1/P2解消・新規P0/P1/P2なしと判定し、OK with notes。前回の「成功ログに失敗が混在」という記述も撤回。共有反映・元run再開は引き続き別承認。
