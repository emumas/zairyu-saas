# @zairyu/db

Drizzle ORM + PostgreSQL。スキーマは `src/schema.ts`、セキュリティ設定は `migrations/0001_security.sql`(手書き)。

## テナント分離の仕組み

1. テナントに属するテーブルはすべて `tenant_id` を持ち、既定値はセッション変数 `app.tenant_id`
2. RLS(`FORCE ROW LEVEL SECURITY`)で `tenant_id = app.tenant_id` の行だけ読み書きできる
3. API は `withTenant(db, tenantIdFromSession, tx => ...)` の中でだけテナントのデータを触る。
   この関数が `SET LOCAL ROLE zairyu_app` と `app.tenant_id` を設定する

| ロール | 用途 | 入口 |
| --- | --- | --- |
| `zairyu_app` | API・ワーカー。自テナントのみ | `withTenant` |
| `zairyu_platform` | 運営者コンソール。テナント・プラン・請求のみ(登録者・カード・確認履歴は権限なし) | `withPlatform` |
| `zairyu_purge` | 保存期間切れの削除ジョブ。確認履歴・監査ログを DELETE できる唯一のロール | `withPurge` |
| `zairyu_auth` | ログイン時のユーザー検索関数 `auth_lookup_user` の所有者 | `lookupUserForLogin` |

確認履歴(`verifications`)と監査ログ(`audit_logs`)は権限とトリガーの二重で UPDATE / DELETE / TRUNCATE を拒否する。
所有者でも拒否され、`zairyu_purge` の DELETE だけが通る(1-21 の保存期間切れ削除のため)。

## コマンド

```bash
pnpm db:generate     # schema.ts の変更から SQL を生成(migrations/)
pnpm db:migrate      # DATABASE_URL に適用
```

RLS ポリシーや権限を変えるときは `pnpm --filter @zairyu/db exec drizzle-kit generate --custom --name <名前>` で空の SQL を作って手書きする。
**テナントに属するテーブルを追加したら、`0001_security.sql` と同様に RLS と権限を付けること**(`test/security.test.ts` が RLS の付け忘れを検出する)。

## 接続ユーザー(本番・Azure)

マイグレーションが作るのは NOLOGIN のグループロールだけ。接続用のユーザーは別に作り、所属させる。

```sql
CREATE ROLE zairyu_api LOGIN PASSWORD '...' NOINHERIT;  GRANT zairyu_app TO zairyu_api;
CREATE ROLE zairyu_console LOGIN PASSWORD '...' NOINHERIT; GRANT zairyu_platform TO zairyu_console;
CREATE ROLE zairyu_purger LOGIN PASSWORD '...' NOINHERIT; GRANT zairyu_purge TO zairyu_purger;
```

`NOINHERIT` にしておくと、`SET ROLE` しない限りテーブルに触れない(`withTenant` 等を通らない直アクセスを防ぐ)。
マイグレーションを流す管理ユーザーは、`auth_lookup_user` の所有者を変えるため `zairyu_auth` のメンバーである必要がある。

## テスト

`TEST_DATABASE_URL` を設定すると、実際の PostgreSQL で RLS・権限・追記専用を検証する(未設定ならスキップ)。
指定した DB の `public` スキーマを作り直すので、テスト専用の DB を使うこと。

```bash
TEST_DATABASE_URL=postgres://user:pass@localhost:5432/zairyu_test pnpm --filter @zairyu/db test
```
