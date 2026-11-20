# 開発環境の準備(Windows + Android 実機)

ログイン・カード登録を試すには、PC に PostgreSQL が必要です(フェーズ0 の PoC 画面だけなら不要)。

## 1. PostgreSQL を入れる(初回だけ)

1. https://www.postgresql.org/download/windows/ から PostgreSQL 16 以降のインストーラーを入れる
   - 途中で決める `postgres` ユーザーのパスワードを控える。ポートは 5432 のまま
   - Stack Builder は不要(チェックを外してよい)
2. スタートメニューの「SQL Shell (psql)」を開き、Enter を 4 回(既定値)→ パスワードを入力して、次を実行する

   ```sql
   CREATE DATABASE zairyu;
   ```

## 2. API の設定ファイルを作る(初回だけ)

`zairyu-saas` フォルダで実行します。`<パスワード>` は 1 で決めたもの、`<IP>` は `ipconfig` で調べた PC の IPv4 アドレスです。

```powershell
pnpm --filter api dev:init-env -- --database-url "postgres://postgres:<パスワード>@localhost:5432/zairyu" --public-url "http://<IP>:3000"
```

`apps\api\.env` ができます。中の鍵はこの PC 専用です(コミットしない)。

## 3. DB を作り、管理者ユーザーを作る(初回と、DB の変更があったとき)

```powershell
pnpm --filter api dev:setup -- --email "自分のメールアドレス" --password "12文字以上のパスワード"
```

テナント「開発用テナント」・拠点「本社」・テナント管理者ができます。2 回目以降はマイグレーションだけが適用されます。

## 4. 起動する(毎回)

**ウィンドウ①(API)**

```powershell
cd apps\api
pnpm dev
```

`.env` を読むので、`$env:...` の指定は不要です。

**ウィンドウ②(Metro)**

```powershell
cd apps\mobile
pnpm start -- --clear
```

ネイティブのモジュールが増えたときは、代わりに `pnpm android` でアプリを作り直します(2026-11-20 のログイン・カード登録の追加で必要)。

**ウィンドウ③(Web 管理画面。使うときだけ)**

```powershell
cd apps\web
pnpm dev
```

ブラウザで http://localhost:5173 を開き、アプリと同じメールアドレス・パスワードでログインします(テナント管理者・拠点管理者は認証アプリの 6 桁も入力)。API には Vite が中継するので、API(ウィンドウ①)も起動しておきます。招待リンクの宛先は `apps\api\.env` の `WEB_BASE_URL`(省略時は http://localhost:5173)です。

## 5. アプリでログインする

1. メールアドレスとパスワードでログイン
2. 管理者は初回に「認証アプリの設定」が出る。Google Authenticator などを入れておき、「認証アプリに追加」(同じ端末)または表示されたキーを手で入力 → 表示された 6 桁を入力
3. 以後は、アプリを開くたび(30 秒以上離れたあと)に指紋・顔認証でロックを解除する

## 6. カードを登録する

1. ホームの「登録者を追加」で登録者を作る(社員番号・氏名・拠点)
2. 登録者を選ぶ → 「カードを登録」
3. 表面撮影 → 番号確認 → IC 読み取り → 照合結果(旧様式は満了日などを入力)→ 裏面撮影 → 保存

## 7. アラートを試す(任意)

期限アラートの作成と通知の送信は、本番では定期実行します。開発中は手で実行できます(`apps\api\.env` を読みます)。

```powershell
pnpm --filter worker daily   # 前日の課金対象人数の記録、今日の期限アラートの作成、通知の送信
pnpm --filter worker send    # 送信待ちの通知だけを送る
pnpm --filter worker purge -- --dry-run   # 保存期間が過ぎた退職者の件数(消さない)
pnpm --filter worker purge   # 保存期間が過ぎた退職者のデータと、記録の無い古い画像ファイルを消す(元に戻せない)
```

メールの設定(`ACS_CONNECTION_STRING`・`ACS_SENDER_ADDRESS`)が無い間は、送らずにウィンドウに件数を表示するだけです。
アプリのホームの「アラート(未対応)を見る」で一覧と対応済みの操作ができます。

## 8. 契約・請求を試す(任意)

Web 管理画面の「契約・請求」(テナント管理者)で、今の課金対象人数・当月の見込み額・日別人数を見られます。

- `pnpm --filter api dev:setup -- --email ... --password ...` を実行すると、プランが無ければ開発用の段階制プラン(基本料 10,000 円、〜100 人 300 円、〜500 人 250 円…)が付きます。プランの変更は運営者コンソール(9 章)で行います
- 日別人数は `pnpm --filter worker daily` で前日分が記録されます(本番では毎日 0:30 ごろに定期実行)

## 9. 運営者コンソール(任意)

テナントの開設・契約状態・プラン・個別単価を管理する画面です。テナントのユーザーとは別のアカウントで、画面からは作れません。

```powershell
cd apps\api
pnpm platform:create-operator -- --email ops@example.com --password "12文字以上のパスワード"
```

表示された「キー」を認証アプリに手入力で登録します(キーはこのときだけ表示されます。テナントのメールアドレスとは別のものにしてください)。登録しそびれたときや端末を替えたときは、同じコマンドに `--reset-totp` を付けて実行するとキーを作り直します(パスワードもそのとき指定したものになります)。
ブラウザで http://localhost:5173/platform を開き、メールアドレス・パスワード・認証アプリの 6 桁でログインします。運営者には登録者の氏名などは表示されません。

## 10. 郵便番号データを入れる(初回と、月 1 回ほど)

住居地から郵便番号を自動で入れるため、日本郵便の郵便番号データ(個人情報を含まない公開データ)を DB に入れます。住所は外部に送らず、この DB の中で照合します。

```powershell
cd apps\api
pnpm postal:load
```

日本郵便のサイトから UTF-8 版(utf_ken_all.zip)を取得して全件を入れ替えます(数十秒)。サイトに直接つながらない環境では、ブラウザで https://www.post.japanpost.jp/zipcode/dl/utf-zip.html から zip を保存し、`pnpm postal:load -- --file <保存した zip のパス>` で入れます。データは毎月更新されるので、本番では月 1 回の定期実行にします。
