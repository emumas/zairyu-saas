# 在留カード管理SaaS 設計書

最終更新: 2026-11-19

## 1. 概要と前提

外国人を雇用する企業向けのSaaS。管理者がiPhone・Androidで在留カードを登録し、ICチップで真贋を確かめ、期限と就労制限を管理する。契約・課金・一括管理はWeb管理画面で行う。

| 項目 | 決定事項 |
| --- | --- |
| 提供形態 | 外部企業向けSaaS(マルチテナント) |
| 操作者 | 各社の管理者のみ。従業員本人はログインしない |
| 規模 | 1テナントあたり登録者1,000人単位 |
| 登録方法 | カメラ撮影 + ICチップ読み取り(NFC)+ 電子署名検証 |
| 課金 | 登録人数に応じた従量課金。Stripeのカード決済が基本 |
| 開発方針 | 既存版は流用せず作り直す |

## 2. 制度上の前提

2026年6月14日以降の新様式カードでは券面に載らない項目があるため、ICチップの読み取りは必須機能とする。

- **新様式と特定在留カード**: 2026年6月14日から、マイナンバーカード機能付きの特定在留カードと新様式の在留カードの交付が始まった。旧様式と混在する。
- **券面に載らない項目**: 新様式では「在留期間」「許可の種類」「許可年月日」「交付年月日」が券面になく、ICにのみ記録される。満了日・就労制限の有無・資格外活動許可は券面にも載る。
- **IC認証**: 券面の在留カード番号を鍵とした認証が必要(BAC相当)。通信はセッションごとの鍵によるセキュアメッセージングで暗号化される。先に番号を読み取る必要がある。
- **電子署名**: 発行時に出入国在留管理庁長官の電子署名が付く。署名対象は券面(表)イメージと顔画像の連結のSHA-256ハッシュ(PKCS#1 v1.5)。
- **仕様書**: 入管庁が「在留カード等仕様書」「第二世代在留カード等仕様書」「特定在留カード等仕様書」を公開(2026年4月改訂)。製品化予定の事業者にはサンプルカードの貸与がある。
- **雇用主が見る欄**: 表面「就労制限の有無」、裏面「資格外活動許可欄」、在留期間の満了日。裏面の追記欄に「在留資格変更許可申請中」等が追記される。
- **失効情報照会**: https://lapse-immi.moj.go.jp/html/top.html に番号と有効期間の満了日を入力して番号の有効性を確認する。公開APIはない。海外IPからはアクセス不可。当日交付分は翌日以降に反映。

## 3. 機能一覧

| 機能 | 内容 | 端末 | フェーズ |
| --- | --- | --- | --- |
| 登録者管理 | 社員番号、拠点、在籍状態(有効・退職・アーカイブ) | アプリ・Web | 1 |
| カード登録 | 表裏撮影、番号OCR、IC読み取り、署名検証、券面とICの照合 | アプリ | 1 |
| 期限ダッシュボード | 期限切れ/30日以内/90日以内/更新申請中/IC未検証/要確認の件数と一覧 | アプリ・Web | 1 |
| 期限アラート | 満了日の90・60・30日前と当日に管理者へプッシュとメール。更新申請中は特例期間(最大2か月)を追跡 | アプリ・Web | 1 |
| 確認履歴 | 誰が・いつ・どの方法(IC署名検証・OCR・目視・失効照会)で確認したか。CSV/PDF出力 | アプリ・Web | 1 |
| 失効照会(半自動) | アプリ内ブラウザで照会ページを開き、結果を管理者が記録 | アプリ | 1 |
| CSV一括取込 | 従業員マスタの取り込み(カード情報はアプリで登録) | Web | 1 |
| 組織管理 | 拠点、管理者ユーザー、権限 | Web | 1 |
| 契約・請求 | カード登録、当月の課金対象人数、請求書閲覧 | Web | 1 |
| 運営者コンソール | テナント管理、料金プランと個別単価 | Web | 1 |
| 就労可否の自動判定 | 在留資格・就労制限・資格外活動許可から就労可否と可能時間を判定 | アプリ・Web | 2 |
| 週就労時間チェック | 資格外活動の人の週合計を勤怠CSVから集計し、28時間に近づくと警告 | Web | 2 |
| 英語対応 | 管理画面の英語化 | アプリ・Web | 2 |
| PC+ICカードリーダー | Web管理画面からの読み取り(拡張APDU対応リーダー) | Web | 3 |
| ハローワーク届出連携 | 外国人雇用状況届出データの作成 | Web | 3 |

## 4. 登録・IC読み取りフロー

1. 登録者を選ぶ(または新規作成)
2. 表面を撮影し、端末内OCRで在留カード番号(英字2文字+数字8桁+英字2文字)を抽出。読めなければ手入力
3. NFCでICを読む(番号による認証 → セキュアメッセージング → 券面情報・顔写真・追記情報の取得)
4. 読み出しデータをサーバーに送り、入管庁の公開鍵で電子署名を検証(証明書の更新をサーバーで一元管理するため)
5. ICの券面画像・顔写真と撮影した実物を並べて表示し、氏名・番号・満了日の一致を自動チェック
6. 裏面を撮影し、追記欄と資格外活動許可欄の画像を保存
7. 管理者が確認して保存。確認方法・結果・操作者・端末を確認履歴に自動記録

例外:
- **ICが読めない**(金属の机の上、破損、端末非対応): OCRと目視で仮登録し「IC未検証」としてダッシュボードに残し、再読取を促す
- **署名検証に失敗**: 「要確認(偽造の疑い)」として保存し、テナント管理者に即時通知。入管局・労働局への相談を案内
- **券面とICが食い違う**: 差分を表示し、管理者が理由を入力しないと保存できない

### 失効照会(半自動)

1. 登録者詳細の「失効照会」ボタンでアプリ内ブラウザ(SFSafariViewController / Custom Tabs)を開く
2. カード番号と満了日をコピーしやすい形で表示
3. 管理者が照会し、アプリに戻って結果(有効/失効)を選ぶ
4. `verifications` に method=revocation_check で記録
5. 交付当日のカードは翌日に再照会アラート

サーバーからの機械的照会・スクレイピングは実装しない。

## 5. マルチテナントと権限

全テーブルにテナントIDを持たせ、API層のテナント固定とPostgreSQLのRLSの二重で他社データが見えない作りにする。

| ロール | 範囲 | できること |
| --- | --- | --- |
| 運営者 | 全テナント | テナントの開設・停止、料金プラン設定。登録者の個人情報は見ない |
| テナント管理者 | 自社の全拠点 | 拠点・ユーザー管理、契約・請求、全登録者の管理と出力 |
| 拠点管理者 | 担当拠点 | 登録者とカードの登録・更新、アラート対応 |
| 閲覧者 | 担当拠点 | 期限と就労可否の閲覧のみ(カード画像は見ない) |

認証はメール+パスワード。テナント管理者と拠点管理者はTOTP必須。アプリは生体認証で再ロック。SSOはフェーズ3。

## 6. 従量課金設計(Stripe)

課金対象は「月内の有効登録者数の日次最大値」。自社で集計した値を月末にStripeへ送る。

**数え方**
- 毎日深夜にテナントごとの有効登録者数を `daily_counts` に記録し、月末に最大値を `billing_periods.peak_count` として確定
- 退職・アーカイブした人は翌日から数えない。日別人数は請求根拠としてWebで公開

**料金モデル(運営者コンソールで設定)**

| 方式 | 内容 |
| --- | --- |
| 基本料+単価 | 月額基本料 + 登録者1人あたりの単価 |
| 段階制 | 人数帯(例: 〜100、〜500、〜1,000、それ以上)ごとに単価を変える |
| 個別単価 | 大口契約などテナント単位で上書き |

**Stripe連携**
- 契約時に Stripe Checkout でカード登録。基本料(固定)と人数分(従量)の2価格でサブスクリプションを作る
- 人数分は Billing Meters(集計方法 Last)。月末に確定した最大人数を1回送る
- Webhook(invoice.paid / invoice.payment_failed / customer.subscription.updated)で `tenants.status` を同期
- カード変更・請求書閲覧は Stripe カスタマーポータル
- 適格請求書: 登録番号と税率別合計を請求書設定と Tax Rates で出す(必須項目は自動では入らない)

**未払い時**: 支払い失敗から14日(案)は通常利用可。その後は新規登録のみ停止し、閲覧と期限アラートは止めない。

## 7. データモデル

全テーブルに `tenant_id`(下表では省略)。`verifications` と `audit_logs` は追記専用。

| テーブル | 主なカラム | 備考 |
| --- | --- | --- |
| tenants | name, status(trial / active / past_due / suspended), stripe_customer_id, plan_id, retention_years | 契約単位 |
| sites | name | 拠点 |
| users | email, password_hash, role, totp_secret_enc | 管理者。担当拠点は user_sites |
| user_sites | user_id, site_id | |
| persons | site_id, employee_code, name, nationality, birth_date, status(active / retired / archived), retired_at | 登録者。status が課金対象の判定 |
| residence_cards | person_id, card_format(legacy / gen2 / tokutei), card_number_enc, card_number_hmac, status_of_residence, period_of_stay, permission_type, permitted_at, expiry_date, card_valid_until, work_restriction, outside_activity, pending_application, ic_verified, is_current | 番号は暗号化、検索はHMAC |
| card_images | card_id, kind(front / back / ic_face / ic_front), blob_key | 実体は暗号化してBlob |
| verifications | card_id, method(ic_signature / ocr / visual / revocation_check), result(ok / mismatch / failed / revoked), diff_json, note, performed_by, device_id, performed_at | 追記専用 |
| alerts | person_id, type(expiry_90 / expiry_60 / expiry_30 / expired / recheck_revocation / hours_limit), due_date, sent_at, acknowledged_by, acknowledged_at | |
| work_hours | person_id, week_start, hours | フェーズ2 |
| plans | name, base_fee, billing_mode(per_unit / tiered), unit_price, tiers_json | 金額は整数(円) |
| tenant_price_overrides | plan_id, unit_price, tiers_json | 個別単価 |
| daily_counts | date, active_count | |
| billing_periods | period(YYYY-MM), peak_count, amount, stripe_invoice_id, status | |
| audit_logs | actor_id, action, target_type, target_id, ip, at | カード画像の閲覧も記録 |

実装時の追加(`packages/db`):
- `verifications.result` に `unverifiable`(年少者カード等で署名がなく IC 署名検証ができない)を追加
- `residence_cards` に `card_kind`(在留カード/特別永住者証明書)、`needs_review`、`issued_at`、`pending_application_since`、`outside_activity_until` を追加
- `platform_operators`(運営者アカウント)を追加。運営者はテナントに属さない
- `work_hours.hours` は浮動小数点を避けて `minutes`(整数)にした
- 追記専用テーブルの削除は保存期間切れ削除ジョブ専用ロール(`zairyu_purge`)だけに許可し、1-21 と両立させた

## 8. API設計(tRPC)

アプリとWebで同じルーターを共有。Stripe Webhook のみ REST。全手続きでテナントと拠点の範囲をミドルウェアで強制。

| ルーター | 主な手続き | 権限 |
| --- | --- | --- |
| auth | login, verifyTotp, refresh, logout | 全員 |
| persons | list(検索・絞り込み・ページング), get, create, update, retire, archive | 拠点管理者以上(閲覧は閲覧者も) |
| cards | startRegistration, submitIcRead(署名検証と照合を実行), uploadImage, confirm, getImageUrl(短命な署名付きURL) | 拠点管理者以上 |
| verifications | list, recordRevocationCheck, recordVisual | 拠点管理者以上 |
| dashboard | summary(期限区分ごとの件数), listByBucket | 閲覧者以上 |
| alerts | list, acknowledge | 拠点管理者以上 |
| imports | uploadPersonsCsv, preview, commit | テナント管理者 |
| org | sites.*, users.*(招待・権限変更・停止) | テナント管理者 |
| billing | createCheckoutSession, createPortalSession, currentUsage, dailyCounts | テナント管理者 |
| reports | exportVerifications(CSV / PDF), exportAuditLogs | テナント管理者 |
| platform | tenants.*, plans.*, priceOverrides.* | 運営者 |
| POST /webhooks/stripe | 請求・決済・サブスクリプションのイベント受信 | Stripe署名検証 |

定期ジョブ: 日次の人数記録と期限アラート生成(毎日深夜 JST)、月次の課金確定とStripe送信(月初)。

## 9. 画面一覧

| 画面 | 端末 | 内容 |
| --- | --- | --- |
| ログイン | アプリ・Web | メール+パスワード、TOTP、アプリは生体認証で再ロック |
| ダッシュボード | アプリ・Web | 期限切れ・30日以内・90日以内・更新申請中・IC未検証・要確認の件数タイル |
| 登録者一覧 | アプリ・Web | 氏名・社員番号で検索、拠点・期限区分・在留資格で絞り込み |
| 登録者詳細 | アプリ・Web | 現在のカード、過去のカード、確認履歴、アラート、失効照会ボタン |
| カード登録ウィザード | アプリ | 表面撮影 → 番号確認 → IC読取 → 照合結果 → 裏面撮影 → 保存 |
| IC再検証 | アプリ | 登録済みカードのICを読み直し、履歴に追記 |
| アラート一覧 | アプリ・Web | 未対応と対応済み |
| CSV取込 | Web | プレビュー、エラー行表示、確定 |
| 拠点・ユーザー管理 | Web | 拠点追加、招待、権限・担当拠点 |
| 履歴・監査ログ出力 | Web | 期間・拠点指定で CSV / PDF |
| 契約・請求 | Web | プラン、当月の課金対象人数と日別推移、Stripeポータルへの導線 |
| 運営者コンソール | Web | テナント一覧、契約状態、プランと個別単価 |

## 10. 非機能要件・セキュリティ・個人情報

- **暗号化**: TLS、DB/ストレージの保存時暗号化に加え、カード番号と画像はテナント別鍵(Key Vault)でアプリ層暗号化
- **端末**: 撮影画像とICデータは送信後に削除。カメラロール保存禁止。Android は FLAG_SECURE、iOS はアプリ切替時に画面をぼかす
- **画像配信**: 数分で切れる署名付きURLのみ。閲覧は監査ログに記録
- **保存期間**: 退職後の保存期間をテナントごとに3〜5年で設定(標準5年)。過ぎたら自動削除
- **OCR**: 端末内のみ。海外AI APIに画像を送らない
- **契約上の立場**: 運営者は個人データ取扱いの委託先。利用規約、データ処理契約、安全管理措置の説明書を用意
- **性能**: 1テナント数千人で一覧・ダッシュボードが1秒以内(サーバー側ページングとインデックス)
- **可用性**: DBのポイントインタイム復元を有効化。アラート送信失敗は再送

## 11. 技術構成

| 層 | 採用 | 注意 |
| --- | --- | --- |
| アプリ | Expo(Development Build)+ React Native + TypeScript | NFCのため Expo Go 不可 |
| NFC | react-native-nfc-manager | iOS は Core NFC の ISO 7816。エンタイトルメントと Info.plist への対象AID記載が必要。Android は IsoDep |
| 端末内OCR | react-native-vision-camera + ML Kit テキスト認識 | カード番号だけを読む |
| Web管理画面 | React(Vite) | tRPC の型を共有 |
| API | Node.js + tRPC | |
| DB | PostgreSQL(Azure Database for PostgreSQL)+ Drizzle ORM | RLS でテナント分離 |
| ストレージ | Azure Blob Storage(非公開) | 署名付きURLのみ |
| 鍵管理 | Azure Key Vault | テナントごとの暗号鍵 |
| 決済 | Stripe Billing + Checkout + カスタマーポータル | |
| 通知 | Expo Push + メール(Azure Communication Services 等) | |
| 実行環境 | Azure App Service(API・Web)+ ワーカー(定期ジョブ) | 日本リージョン |

対応端末は NFC(Type B)対応の iPhone と Android。iPad は NFC 非対応のため IC 読取不可。

## 12. 開発フェーズと残課題

1. **フェーズ0(PoC)**: 旧様式・新様式・特定在留カードを iPhone と Android で読み、署名検証まで通す
2. **フェーズ1(MVP)**: テナントと権限、登録者管理、カード登録とIC検証、期限ダッシュボードとアラート、確認履歴、失効照会(半自動)、Stripe課金
3. **フェーズ2**: 就労可否の自動判定、週就労時間チェックと勤怠CSV連携、英語対応
4. **フェーズ3**: PC+ICカードリーダー、ハローワーク届出連携、SSO、外部API

残課題(実装に影響しないため後で決める):
- 料金(基本料・単価・人数帯)と無料トライアル。案: 基本料+1人200〜400円、1,000人超は単価を下げる段階制、初月無料
- 支払い失敗時の猶予期間(案: 14日)
- 入管庁へのサンプルカード貸与の申請(PoC前に必要)
- 退職後の保存期間の法務確認

## 13. 競合

- **ロムテン**(タブソリューション): IC偽造判定、200以上の組み合わせからの就労可否自動判定、期限メール通知、失効情報照会、ハローワーク届出、API連携、Windows+ICカードリーダー対応。価格は非公開(店舗・事業所数と従業員数で見積もり)。2020年の開始時は1アカウント月額1,500円〜
- **ビザマネ**(DXHUB): IC偽造チェック、就労可否判定、外国人雇用状況届出書の作成

差別化の軸: 勤怠連携の週28時間チェック、監査証跡として出せる確認履歴、人数ベースの明快な従量課金。

## 参考資料

- 在留カード等のICチップ読み出し仕様の公開: https://www.moj.go.jp/isa/applications/disclosure/120424_01.html
- 第二世代在留カード等仕様書の公開について: https://www.moj.go.jp/isa/publications/resources/120424_01_00003.html
- 特定在留カード等仕様書 Ver1.1: https://www.moj.go.jp/isa/content/001460712.pdf
- 在留カード等仕様書 Ver1.5: https://www.moj.go.jp/isa/content/001414093.pdf
- 在留カード等番号失効情報照会について: https://www.moj.go.jp/isa/content/001458102.pdf
- 読取アプリ/失効情報照会 サポートページ: https://www.moj.go.jp/isa/applications/procedures/rcc-support.html
- Stripe usage-based billing: https://docs.stripe.com/billing/subscriptions/usage-based/how-it-works
- Stripe 日本の請求書: https://stripe.com/at/guides/best-practices-for-setting-up-invoicies-in-japan
- App Review Guidelines: https://developer.apple.com/app-store/review/guidelines/
