# 在留カード管理SaaS — Claude Code 向けガイド

外国人を雇用する企業向けのマルチテナントSaaS。各社の管理者がiPhone/Androidで在留カードを登録し、ICチップの電子署名で真贋を確認し、在留期限と就労制限を管理する。契約・課金・一括管理はWeb管理画面で行う。

詳細設計は `docs/DESIGN.md`、実装タスクは `docs/TASKS.md` を参照。作業はTASKS.mdのフェーズ0(PoC)から順に進めること。

## 技術スタック

- モノレポ(pnpm workspaces + Turborepo)、TypeScript strict
- `apps/mobile`: Expo(Development Build)+ React Native。NFCは `react-native-nfc-manager`、カメラ/OCRは `react-native-vision-camera` + ML Kit テキスト認識
- `apps/web`: React + Vite(Web管理画面・運営者コンソール)
- `apps/api`: Node.js + tRPC(+ Stripe Webhook 用の REST エンドポイント 1本)
- `apps/worker`: 定期ジョブ(日次人数記録、期限アラート、月次課金確定)
- `packages/db`: Drizzle ORM + PostgreSQL(Azure Database for PostgreSQL)
- `packages/zairyu-ic`: 在留カードICの読み出し・TLVパース・署名検証ロジック(端末側とサーバー側で共有)
- `packages/shared`: zod スキーマ、型、定数
- インフラ: Azure App Service / Blob Storage / Key Vault、決済は Stripe Billing

## 絶対に守るルール

1. **テナント分離**: 全テーブルに `tenant_id`。tRPC のミドルウェアでセッションからテナントを固定し、PostgreSQL の RLS でも二重に守る。テナントIDをクライアント入力から受け取らない。
2. **個人情報**: カード番号と画像はテナント別の鍵(Key Vault)でアプリ層暗号化。検索はHMACハッシュ列で行う。ログ・エラーメッセージ・Sentry等にカード番号や氏名を出さない。
3. **画像を外部AIに送らない**: OCRは端末内(ML Kit)のみ。Claude Vision 等の海外APIにカード画像を送る実装はしない。
4. **端末に残さない**: 撮影画像・ICデータは送信後に削除。カメラロールに保存しない。Android は FLAG_SECURE、iOS はバックグラウンド移行時に画面をぼかす。
5. **確認履歴は追記専用**: `verifications` と `audit_logs` は UPDATE/DELETE しない(DB権限でも禁止)。
6. **失効情報照会は自動化しない**: 入管庁の照会ページへのスクレイピングや機械的アクセスは実装しない。アプリ内ブラウザで開き、管理者が結果を記録する半自動方式のみ。
7. **アプリ内課金を置かない**: アプリに料金表示・購入導線・個人向け新規登録を置かない(App Store 3.1.3(c) 前提)。契約と決済はWebのみ。
8. UI文言は日本語。日付は Asia/Tokyo 基準で扱う。

## コーディング規約

- 入出力は zod で検証し、tRPC の input/output 型を mobile/web で共有する
- DBアクセスは `packages/db` のリポジトリ関数経由。生SQLは RLS ポリシーとマイグレーションのみ
- 金額は整数(円)で扱う。浮動小数点を使わない
- テストは Vitest。課金計算、期限区分、TLVパース、署名検証、権限チェックは必ず単体テストを書く
- 秘密情報は環境変数/Key Vault。リポジトリにコミットしない

## よく使うコマンド(セットアップ後に整備すること)

```
pnpm install
pnpm dev            # api + web + worker
pnpm --filter mobile run android | ios   # Development Build
pnpm test
pnpm db:generate && pnpm db:migrate
```
